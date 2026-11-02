/**
 * 会话媒体的平台层（#67 第四步）：选图 / 录音 / 直传 / 鉴权下载。
 *
 * 与 `features/upload/api.ts`（商品图，走 `UPLOAD_ROUTES.presign/confirm`）**刻意分开**：
 * 会话媒体是另一套端点（`CHAT_ROUTES.mediaPresign/media/mediaObject`），服务端还要按
 * 媒体类型解析真实尺寸 / 时长再逐个比对，校验口径与错误码都不一样。这里只复用不依赖
 * 上传业务的平台工具（`upload/mime` 判 mime、`upload/choose-error` 判「用户取消」）。
 *
 * 三条踩过的平台约束：
 * 1. `presign.headers` 是空对象（签名只覆盖 host，契约 §7.7），PUT 必须**显式带
 *    `content-type`**：对象存储会把 PUT 的 Content-Type 落成对象 mime，而 create 时
 *    服务端按 `stat.contentType` 严格比对，漏了它直接 422「媒体实际属性与声明不一致」。
 * 2. `sizeBytes` 一律取**读出来的字节长度**，不用 `chooseMedia` / 录音机报的值：
 *    presign 的声明值与 create 的声明值必须是同一个数，否则服务端 `stat.size` 比对失败。
 * 3. 图片 `width/height` 服务端会按真实字节重解析并**逐个比对**（`media-service.ts`
 *    的 `input.width !== probed.width || input.height !== probed.height`），所以只能用
 *    `getImageInfo` 解出来的真实尺寸，不能估算。
 */
import { CHAT_ROUTES } from '@fish/contracts/chat/routes'
import {
  MEDIA_MAX_VOICE_DURATION_MS,
  type MediaKind,
  type MediaMessageDto,
  type MediaPresignResponse,
  mediaListResponseSchema,
  mediaPresignResponseSchema,
} from '@fish/contracts/chat/schema'
import Taro from '@tarojs/taro'
import { isChooseMediaCancel } from '@/features/upload/choose-error'
import { type AllowedImageMime, mimeFromPath } from '@/features/upload/mime'
import { API_BASE } from '@/lib/api-base'
import { apiRequest } from '@/lib/request'
import { sessionCookieHeader } from '@/lib/session'
import {
  assertMediaActive,
  type ChatImageMime,
  imageRejectReason,
  mediaObjectUrl,
  normalizeRecordedWav,
  type VoiceMime,
  voiceMimeFromBytes,
} from './media'

/** 直传超时：5MB 弱网首包可能很慢，比普通请求的 15s 宽（同 `features/upload/api.ts`）。 */
const UPLOAD_TIMEOUT_MS = 60_000

/** 鉴权下载超时：私有媒体要先过业务 API 代理再回字节，比普通请求宽。 */
const DOWNLOAD_TIMEOUT_MS = 60_000

/** 本地临时路径缓存上限：只为了避免同一屏反复下载，超出后丢最早的。 */
const MEDIA_PATH_CACHE_LIMIT = 60

/**
 * `getImageInfo` 回的格式 → 契约白名单 mime。
 *
 * 为什么不信路径后缀：`chooseMedia` 给的是**临时文件**，真机上常见没有后缀的名字，
 * 按后缀判会把合法图片误报成「格式不支持」。后缀只在拿不到 `type` 时兜底。
 */
const MIME_BY_IMAGE_TYPE: Record<string, ChatImageMime> = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

/** 已选图片：本地路径只用于预览与上传；`width/height` 必须与服务端解析结果一致。 */
export type PickedChatImage = {
  path: string
  mime: AllowedImageMime
  width: number
  height: number
  sizeBytes: number
}

export type ChatImagePick = {
  images: PickedChatImage[]
  /** 被本地校验挡下的原因（只保留最后一条），`null` = 全部通过 */
  rejected: string | null
}

/** 录音结果；`durationMs` 只用于本地乐观态，服务端会按字节重解析并覆盖。 */
export type RecordedVoice = {
  path: string
  durationMs: number
}

/**
 * 直传完成后 create 需要的声明值（`sizeBytes` 已换成真实字节长度）。
 *
 * 带 `kind` 判别式：页面把它们原样存进本地乐观媒体（`PendingMedia.uploaded`），
 * 重试时按这个判别式挑 create 的入参，不做字符串比较。
 */
export type UploadedImage = {
  kind: 'IMAGE'
  objectKey: string
  contentType: string
  sizeBytes: number
  width: number
  height: number
}

export type UploadedVoice = {
  kind: 'VOICE'
  objectKey: string
  contentType: string
  sizeBytes: number
  durationMs: number
}

/**
 * 选图。最多 `limit` 张。
 *
 * `source` 决定相册还是相机（#359 3b 的「图片」/「拍照」两格）：`album` 只开相册，
 * `camera` 只开相机。不传时两者都给（历史行为）。
 *
 * **只有用户取消**才当「没选」返回空数组（否则每次取消都会弹一个吓人的错误）；
 * 权限被拒 / 相机异常 / 平台失败一律抛出可展示的错误，由页面提示并让用户重试。
 */
export async function pickChatImages(
  limit: number,
  source: 'album' | 'camera' | 'both' = 'both',
): Promise<ChatImagePick> {
  if (limit <= 0) return { images: [], rejected: null }

  let result: Taro.chooseMedia.SuccessCallbackResult
  try {
    result = await Taro.chooseMedia({
      count: limit,
      mediaType: ['image'],
      sourceType: source === 'both' ? ['album', 'camera'] : [source],
      // compressed：iOS 相册原图常是 HEIC，压缩后通常是 JPG，能直接过契约白名单
      sizeType: ['compressed'],
    })
  } catch (error) {
    if (isChooseMediaCancel(error)) return { images: [], rejected: null }
    throw new Error(
      source === 'camera' ? '无法拍照，请检查相机权限后重试' : '无法选择图片，请检查相册权限后重试',
    )
  }

  const images: PickedChatImage[] = []
  let rejected: string | null = null
  for (const file of result.tempFiles) {
    const info = await readImageInfo(file.tempFilePath)
    if (!info) {
      rejected = '无法读取这张图片，请换一张试试'
      continue
    }
    const mime =
      MIME_BY_IMAGE_TYPE[info.type?.trim().toLowerCase() ?? ''] ?? mimeFromPath(file.tempFilePath)
    if (!mime) {
      rejected = '仅支持 JPG / PNG / WebP 图片'
      continue
    }
    const tooBig = imageRejectReason(file.size)
    if (tooBig) {
      rejected = tooBig
      continue
    }
    images.push({
      path: file.tempFilePath,
      mime,
      width: info.width,
      height: info.height,
      sizeBytes: file.size,
    })
  }
  return { images, rejected }
}

async function readImageInfo(
  path: string,
): Promise<{ width: number; height: number; type?: string } | null> {
  try {
    const info = await Taro.getImageInfo({ src: path })
    if (!info.width || !info.height) return null
    return { width: info.width, height: info.height, type: info.type }
  } catch (error) {
    console.error('[chat-media] getImageInfo 失败', error)
    return null
  }
}

/**
 * 上传单张图片，返回 create 需要的声明值（`sizeBytes` = 真实字节长度）。
 *
 * `isActive` 是调用方的在途判据（会话页传 `() => !isStale()`）：**读文件之后**、presign 之前
 * 与直传 PUT 之前各问一遍，换号 / 卸载后立刻中止，不再发出后续鉴权请求（#67 复查 #222）。
 */
export async function uploadChatImage(
  conversationId: string,
  image: PickedChatImage,
  isActive?: () => boolean,
): Promise<UploadedImage> {
  assertMediaActive(isActive)
  const buffer = await readLocalFile(image.path, '图片读取失败，请重试')
  // 读文件是异步的：这一步回来时账号可能已经变了，presign / PUT 都不该再发
  assertMediaActive(isActive)
  const objectKey = await putObject(conversationId, 'IMAGE', image.mime, buffer, isActive)
  return {
    kind: 'IMAGE',
    objectKey,
    contentType: image.mime,
    sizeBytes: buffer.byteLength,
    width: image.width,
    height: image.height,
  }
}

/**
 * 上传一段录音。
 *
 * 容器由**字节头**判定（不信任录音机声明的格式）：契约只接受可解析时长的 WebM / MP4 / WAV，
 * 认不出来就明确报错，而不是发一个必然 422 的请求让用户看到「媒体实际属性与声明不一致」。
 * `isActive` 的语义同 `uploadChatImage`。
 */
export async function uploadChatVoice(
  conversationId: string,
  voice: RecordedVoice,
  isActive?: () => boolean,
): Promise<UploadedVoice> {
  assertMediaActive(isActive)
  const raw = await readLocalFile(voice.path, '语音读取失败，请重试')
  assertMediaActive(isActive)
  const buffer = normalizeRecordedWav(raw)
  const contentType: VoiceMime | null = voiceMimeFromBytes(buffer)
  if (!contentType) {
    const bytes = new Uint8Array(buffer)
    const header = Array.from(bytes.slice(0, 16), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join(' ')
    console.error('[chat-media] 不支持的录音容器', { sizeBytes: buffer.byteLength, header })
    throw new VoiceContainerError(buffer.byteLength, header || 'empty')
  }
  const objectKey = await putObject(conversationId, 'VOICE', contentType, buffer, isActive)
  return {
    kind: 'VOICE',
    objectKey,
    contentType,
    sizeBytes: buffer.byteLength,
    durationMs: voice.durationMs,
  }
}

async function putObject(
  conversationId: string,
  kind: MediaKind,
  contentType: string,
  buffer: ArrayBuffer,
  isActive?: () => boolean,
): Promise<string> {
  assertMediaActive(isActive)
  const presign: MediaPresignResponse = mediaPresignResponseSchema.parse(
    await apiRequest(CHAT_ROUTES.mediaPresign(conversationId), {
      method: 'POST',
      body: { kind, contentType, sizeBytes: buffer.byteLength },
    }),
  )

  // 直传 PUT 不携带会话（只有 presign 的签名），但它会在对象存储里留下真实对象 ——
  // 换号后这一发同样不该再发。
  assertMediaActive(isActive)
  const uploaded = await Taro.request({
    url: presign.uploadUrl,
    method: 'PUT',
    data: buffer,
    // `presign.headers` 当前是空对象（见文件头注释 1），必须显式带上 content-type
    header: { ...presign.headers, 'content-type': contentType },
    timeout: UPLOAD_TIMEOUT_MS,
  })
  if (uploaded.statusCode < 200 || uploaded.statusCode >= 300) {
    console.error('[chat-media] 对象存储上传失败', {
      kind,
      statusCode: uploaded.statusCode,
      errMsg: uploaded.errMsg,
    })
    throw new MediaUploadError(kind, uploaded.statusCode)
  }
  return presign.objectKey
}

/** 媒体历史一页的条数上限（契约 `mediaListQuerySchema.limit` 上限 100）。 */
const MEDIA_PAGE_LIMIT = 50

/** 按媒体历史接口取一页（升序返回，`nextCursor` 指向更早一页） */
export type LoadedMediaPage = {
  items: MediaMessageDto[]
  nextCursor: string | null
  failed: boolean
}

export async function loadMediaPage(
  conversationId: string,
  before?: string,
): Promise<LoadedMediaPage> {
  try {
    const page = await apiRequest(CHAT_ROUTES.media(conversationId), {
      method: 'GET',
      query: { limit: MEDIA_PAGE_LIMIT, cursor: before },
    })
    const parsed = mediaListResponseSchema.parse(page)
    return { items: parsed.items, nextCursor: parsed.nextCursor, failed: false }
  } catch (error) {
    console.error('[chat-media] 媒体历史加载失败', error)
    return { items: [], nextCursor: null, failed: true }
  }
}

/**
 * 下载私有媒体到本地临时文件（验收⑤：不拼公开对象存储地址）。
 *
 * `<Image src>` 与 `innerAudioContext.src` 都带不了会话 Cookie，直接指向业务 API 会 401；
 * `downloadFile` 能带 header，所以图片预览与语音播放统一走这里。
 * 结果按 mediaId 缓存，避免同一屏反复下载；自己刚发出去的媒体由页面直接写缓存。
 *
 * `isActive` 是调用方的在途判据：**写缓存之前**再问一遍（#67 复查 #222）。下载是异步的，
 * 回来时若已经换号 / 离页，这份字节属于上一个身份 —— 写进模块缓存就会被下一个身份复用
 * （私有媒体的临时文件不该跨身份），所以宁可丢掉这次下载结果。
 */
export async function downloadChatMedia(
  conversationId: string,
  mediaId: string,
  isActive?: () => boolean,
): Promise<string> {
  const cached = localMediaPaths.get(mediaId)
  if (cached) return cached

  assertMediaActive(isActive)
  const result = await Taro.downloadFile({
    url: mediaObjectUrl(API_BASE, conversationId, mediaId),
    header: { Cookie: sessionCookieHeader() },
    timeout: DOWNLOAD_TIMEOUT_MS,
  })
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error('媒体加载失败')
  }
  assertMediaActive(isActive)
  cacheMediaPath(mediaId, result.tempFilePath)
  return result.tempFilePath
}

const localMediaPaths = new Map<string, string>()

/** 已下载 / 自己刚发出的媒体的本地路径；页面用它避免「先空白再闪出图片」。 */
export function cacheMediaPath(mediaId: string, path: string): void {
  if (localMediaPaths.size >= MEDIA_PATH_CACHE_LIMIT) {
    const oldest = localMediaPaths.keys().next()
    if (!oldest.done) localMediaPaths.delete(oldest.value)
  }
  localMediaPaths.set(mediaId, path)
}

export function cachedMediaPath(mediaId: string): string | null {
  return localMediaPaths.get(mediaId) ?? null
}

/** 丢掉缓存（换号时必须调用：临时文件属于上一个身份，不该被下一个身份复用）。 */
export function clearMediaCache(): void {
  localMediaPaths.clear()
}

// ---------------------------------------------------------------------------
// 录音
// ---------------------------------------------------------------------------

/*
  平台假设与端上探针（#549 收口判据 (g)）
  ========================================

  这一节是**平台面**的唯一登记处。本文件里凡是拿不到代码证据、只能押平台语义的地方，
  都必须在这里落一条假设（A 编号）和一条能在微信开发者工具 / 真机里跑的探针（D 编号）；
  代码里的注释按编号指回来（不再指向 PR 正文 —— 那不是版本库的一部分，改一次就得追一次）。

  **能拿到的证据只有 SDK 类型声明**（`apps/miniapp/node_modules/@tarojs/taro/types/api/media/recorder.d.ts`），
  不是官方文档（本机解析不到 `developers.weixin.qq.com`）：
  - `onStart`：只写「监听录音开始事件」，**没有**「起录失败不投 onStart」的承诺；
  - `onInterruptionBegin`：微信语音 / 视频通话触发后「**录音会被暂停**」，`onPause` 在其后；
  - `onInterruptionEnd`：「收到此事件之后才可再次录音成功」；
  - `start` / `stop`：只有「开始录音」/「停止录音」，**没有**重复 `start`、未起录时 `stop`、
    `stop` 必回 `onStop` 的任何约定；
  - `onStop` 的结果只有 `tempFilePath` / `duration` / `fileSize` —— **没有「为什么停」**，
    所以「录满 vs 被打断」只能靠时长 + 中断标记去猜（见 `voiceCapped`）。

  假设（**未验证**，不得当事实陈述）
  ----------------------------------
  | 代号 | 假设 | 若不成立的影响 |
  | --- | --- | --- |
  | A1 | 一次**未同步抛错**的 `start()` 所开启的录音，最终恰好投一次 `onStop` 或 `onError` | 闸门一直关着 → 「录音器没有响应」+ 需重开小程序（探针 D3 / D8） |
  | A2 | `start()` **同步抛错**表示平台拒绝了这次起录，不会再有这一段的收尾事件（`startVoiceRecording` 里当场销账的前提） | 迟到的收尾被算到下一段头上（探针 D7 直接测） |
  | A3 | `onInterruptionBegin` **必达**，且代表「录音被暂停 / 音频被截断」 | 平台只暂停却不发 Begin：既无标志也无提示，松手时 `wasInterrupted()===false` → **截断音频被当正常语音发出**。本设计唯一无法从代码侧兜住的平台面空白（探针 D4） |
  | A4 | 中断期间 / 中断之后调用 `stop()` 仍会投一次 `onStop`（否则闸门关到重启） | 「中断一次 = 本会话内语音不可用」（探针 D8） |
  | A5 | 到达 `duration`（`VOICE_RECORD_MAX_MS` = 59s）后录音器自停并投 `onStop`，且回报的 `duration` ≥ 58500 | 「接近一分钟自动发送」这条需求不成立：完整录音会被判成「被打断」而丢弃。`voiceCapped` 的 `- 500ms` 余量就是为它留的（探针 D6） |
  | A6 | 对**同一条已 `stop` / 已放弃的账**重复 `stop()` 幂等或至少无害（不伤到别的段），且能促成终态事件（`onInterruptionEnd` 里补发 `stop()` 的前提，见那里的注释） | 中断后仍可能一直关闸（探针 D8）。数据面不受影响：补发只发生在「账还挂着、闸门关着」时，此时**不可能**有别的段在录（单槽记账），闸门仍只由终态事件打开 |

  端上最小探针（真机 / 微信开发者工具；每条**记录原始事件序列**，不要只记结论）
  -----------------------------------------------------------------------------
  | 代号 | 操作 | 记录什么 | 用途 |
  | --- | --- | --- | --- |
  | D1 | 松手后**立即**再按住（多次，含录满 59s 之后） | 是否出现「上一段录音还在收尾」；松手到可再录的**实测毫秒数** | 收尾窗口量级 |
  | D2 | 上滑取消后**立即**再按住 | 同上；确认被放弃的音频没有被发出去 | 同上 |
  | D3 | 录音中切后台 → 回前台 → 再按住 | 是否一直提示「还在收尾」/「录音器没有响应」 | A1 |
  | D4 | 录音中来电 / 视频通话 → 结束 → 松手 | `onInterruptionBegin` / `onPause` / `onInterruptionEnd` / `onStop` 的**实际顺序**与 `duration`（是否含被打断的那一段） | A3、A5（`voiceCapped` 的 `-500ms` 余量是否安全） |
  | D5 | 极短点按（按下即松） | 是否收到任何收尾事件 | A1 的最短路径 |
  | D6 | 真机录满 59s 一次 | 回报 `durationMs` 是否 ≥ 58500；是否自动发送并落库 | A5、58.5–59.0s 窗口 |
  | D7 | 制造 `start()` 同步抛错（设备被占用等） | 抛错后是否**仍**迟到一次 `onStop` / `onError` | A2 |
  | D8 | 中断（来电 / 视频通话 / 切后台）→ 回前台 → 按住说话，并记录这一段的完整事件序列 | ① 平台是否为**被放弃的这一段**投递终态事件（`onStop` / `onError`）；② 不投时，`onInterruptionEnd` 里补发的 `stop()` 是否把它催了回来、补发 `stop()` 是否抛错；③ 是否仍提示「录音器没有响应」 | A4、A6 |

  **D8 若不成立**（平台永不投终态事件，补发 `stop()` 也催不回来）：唯一合法的出路**不是**
  TTL / 定时解闸（判据 (d) 明令禁止），而是**平台层的「录音器已空闲」信号**——例如一个可查询
  的 `isRecording` 状态、或平台补发一条「录音已释放」事件 —— 由它充当**终态证据**再销账。
  在拿到这类证据之前一律维持 fail-closed，用户可见的恢复动作是重开小程序。

  已知限制（本轮**不改代码**，是判据 (a) 授权的既定代价）
  --------------------------------------------------------
  - **`stop()` 同步抛错也会关闸**（见 `startVoiceRecording` 里 `stop` 的 catch）：一次「点一下
    就松手」若踩到平台异常，闸门保持关闭，下一次只能看到「上一段录音还在收尾」。这是拿不到
    「抛错 ⇒ 已收尾」证据时选择的 fail-closed 方向；解闸只由终态事件决定，不加 TTL。
  - **终态事件丢失 = 本会话内语音不可用**（A1 / A4 不成立的后果）：唯一恢复是重开小程序。
    `onInterruptionEnd` 里补发的 `stop()` 只是尽力催收，**不是**解闸依据。
  - 编号沿革：上一轮集成报告 §10 的 D3 / D8 / D9 三条（切后台、来电后能否继续录、中断后
    `stop()` 与收尾）在本表合并为 **D3 / D8**；A1–A5 口径不变，**A6 为 #549 复审新增**。
*/

type VoiceRecorder = ReturnType<typeof Taro.getRecorderManager>

/**
 * `RecorderManager` 是**全局单例**，`onStop/onError` 注册会一直累积，所以这里只注册一次，
 * 由模块级 `voiceSession` 记账。不这么做的话第二次录音会同时触发上一次遗留的回调
 * （表现为重复发送 / 状态错乱）。
 *
 * 但「只注册一次」≠「只挂一个回调槽」（#535 复审 high）：`onStop` / `onError` 是**异步**
 * 送达的，上一段的事件完全可能落在下一次起录之后。若按「槽里当前是谁」派发，上一段的
 * 结果就会被派给下一段。修法是**不让两段同时挂账**（见 `voiceSession`），而不是给
 * 「这条回调属于谁」再找一条判据。
 */
let voiceRecorder: VoiceRecorder | null = null

type VoiceSession = {
  resolve: (voice: RecordedVoice) => void
  reject: (error: Error) => void
  /** 已经调过 `stop()` / `abort()`：这一笔在等**它自己的** onStop / onError */
  stopRequested: boolean
  /** `abort()` 放弃的这一段：事件到了也直接丢掉（不交付、不弹错） */
  abandoned: boolean
  /**
   * **当前仍处于中断态**（`onInterruptionBegin` 之后、`onInterruptionEnd` 之前）。
   *
   * 只在「当前」有意义，不是「中断发生过」的历史标记（#549 收口判据 2）：中断结束
   * （= 录音恢复）就必须清掉，否则一次已经恢复的正常录音会被历史标记判成「被打断」。
   */
  interrupted: boolean
  /** 起录时刻（ms）：只用来判「这段最迟该在这时交回收尾事件」，见 `settleOverdue` */
  startedAtMs: number
  /** `stop()` / `abort()` 发出的时刻（ms）：同上；没叫过就是 `null` */
  stopRequestedAtMs: number | null
  /** 录音**进行中**失败（页面据此立刻复位 + 提示） */
  onError?: (error: Error) => void
  /** 录音器**自己停了**（没人调用 `stop()`）时的回调 */
  onAutoStop?: (recorded: RecordedVoice, capped: boolean) => void
  /** 被系统占用**打断**（来电 / 视频通话把录音暂停了）时的回调：页面据此放弃这一段 */
  onInterrupted?: () => void
}

/**
 * 正在占用录音器的那**一段**（同一时刻至多一段，#549）。
 *
 * `RecorderManager` 是全局单例，而 `onStop` / `onError` **不带 session id** —— 平台只在
 * 「这一次 `start()` 对应的那一段录音」上投事件，回调本身没有任何字段能指出是哪一段。
 * 所以「这条回调属于谁」只有在**账上永远只有一段**时才有唯一答案；一旦允许两段同时挂账，
 * 任何归属规则都只是猜测：谁先 `stop()`、谁收到过 `onStart`、账龄多长，都不是身份凭据。
 * 猜错的两种后果都很严重 —— 上一段的 `stop` 失败打死正在录的那一段（面板消失、麦克风
 * 还在录），或者上一段的音频被当成新一段「录满」自动发给对方。
 *
 * 这条不变量只在两处维护：起录时的闸（`startVoiceRecording`），以及销账
 * （收尾事件到达；`start()` **同步抛错** —— 起录被平台拒绝，不存在「这一段」，见那里的注释）。
 *
 * **`stop()` / `abort()` 同步抛错不销账**（#549 收口判据 1）：抛错只说明这条命令没被接受，
 * 不说明平台已经收尾。录音可能还在走（那这一段的 `onStop` 迟早会来），也可能已经自己停了、
 * 事件还在路上 —— 两种情况下这条收尾事件都可能晚于下一次起录到达。拿不到平台证据时按
 * fail-closed 处理：账留着、闸门关着，事件真到了自然销账。
 */
let voiceSession: VoiceSession | null = null

/** 销账：`session` 必须是账上那一段，销掉之后收尾事件就没有归属了。 */
function settleSession(session: VoiceSession): void {
  if (voiceSession === session) voiceSession = null
}

/** 当前还在录的那一段（没有叫过 stop、也没被放弃）：只有它会被系统打断。 */
function liveSession(): VoiceSession | undefined {
  if (!voiceSession || voiceSession.stopRequested || voiceSession.abandoned) return undefined
  return voiceSession
}

function recorder(): VoiceRecorder {
  if (voiceRecorder) return voiceRecorder
  const manager = Taro.getRecorderManager()
  // 收尾事件只可能属于账上那一段（起录有闸，单例上一次只会有一段录音在走，见 `voiceSession`）：
  // 先销账再回调，回调里重新起录不该被这一笔挡住。
  manager.onStop((result) => {
    const session = voiceSession
    if (!session) return
    voiceSession = null
    // 放弃的那一段：不交付、不通知（页面已经把它当没录过）
    if (session.abandoned) return
    const recorded = {
      path: result.tempFilePath,
      durationMs: Math.max(0, Math.round(result.duration)),
    }
    session.resolve(recorded)
    // 没人叫过 `stop()` = 录音器自己停的（时长上限 / 系统打断）：这时页面还没松手，
    // 也就没人消费 `stop()`，必须带外通知，否则面板会继续计时。
    if (!session.stopRequested) session.onAutoStop?.(recorded, voiceCapped(session, recorded))
  })
  manager.onError((error) => {
    console.error('[chat-media] 录音机错误', error)
    const session = voiceSession
    if (!session) return
    voiceSession = null
    if (session.abandoned) return
    const failure = voiceError(error)
    session.reject(failure)
    // `stop()` 之后才到的错误会从 `done` 的 reject 走到 `stop()` 的 catch，这里不再重复上报
    if (!session.stopRequested) session.onError?.(failure)
  })
  // 来电 / 视频通话占用麦克风：这一段不是「录满收尾」，而且**当场**就该告诉页面
  manager.onInterruptionBegin(() => {
    const session = liveSession()
    if (!session) return
    session.interrupted = true
    /*
      带外通知（#549，需求 4 的「中断」失效路径）：平台的语义是「录音被暂停」—— 暂停期间
      用户说的话不会被录进去，这一段音频是截断的。只记一个布尔的话，用户要等到松手（或被
      平台自停）才知道出事，那时他已经对着面板又说了半天。页面收到通知就放弃这一段、复位
      面板并明确提示重录；`interrupted` 标记留着兜住「通知晚于松手」的竞态
      （松手投递读 `wasInterrupted`，见 `applyVoiceRelease`）。
    */
    session.onInterrupted?.()
  })
  manager.onInterruptionEnd(() => {
    const session = voiceSession
    if (!session) return
    // 还在录的那一段：中断结束 = 录音恢复，历史标记不许多留一刻（#549 收口判据 2）。
    if (!session.stopRequested && !session.abandoned) {
      session.interrupted = false
      return
    }
    /*
      已经叫过 `stop()` / 被放弃的那一段（页面在 `onInterruptionBegin` 里当场 `abort()`，
      见 `handleVoiceInterrupted`）：它等的只是自己的终态事件，而没有可恢复的页面状态。
      若平台**不补发**终态事件，闸门就关到重开小程序（#549 独立 Spec 审查 M2 实测）——
      中断恢复本身是平台证据，却不是**这一段的**终态事件。

      能做的只有对**这一段自己的账**再补一次 `stop()`，把终态事件催回来：
      - 只对这一段的账（`voiceSession` 仍是它），此时**不可能**有别的录音在走 —— 起录有闸
        （见 `startVoiceRecording`），账没销就起不来新的一段，所以这次 `stop()` 不会误停别人；
      - 过了 `VOICE_RECORD_SETTLE_GRACE_MS` 才发：正常收尾是毫秒级，没过窗口就重发只是噪音；
      - 抛错吞掉（平台回调里没人接），**不解闸** —— 闸门只由终态事件打开；
      - 它是一次**尽力**催收，不是判据：真催不回来就维持 fail-closed（探针 D8 / 假设 A6）。
    */
    if (!settleOverdue(session, Date.now())) return
    try {
      manager.stop()
    } catch (error) {
      console.error('[chat-media] 中断结束后补发停止录音失败', error)
    }
  })
  voiceRecorder = manager
  return manager
}

export type VoiceRecording = {
  /** 结束录音并等 `onStop`（拿到临时文件与时长） */
  stop: () => Promise<RecordedVoice>
  /** 放弃这次录音（不 resolve、不 reject，也不弹错） */
  abort: () => void
  /**
   * 此刻是否**仍处于中断态**（来电 / 视频通话把录音暂停了，还没 `onInterruptionEnd`）。
   *
   * 页面在松手投递前读它（`applyVoiceRelease`）：中断态下这一段音频是被截断的，不能当
   * 正常语音发出去。中断结束（恢复）之后读到的就是 `false` —— 历史上中断过不算数（#549）。
   */
  wasInterrupted: () => boolean
}

/**
 * 录音机的最长时长：**比契约上限少 1 秒**（#364 审查）。
 *
 * 服务端是**严格大于**即拒（`media-service.ts`：`probed.durationMs > MEDIA_MAX_VOICE_DURATION_MS`），
 * 而 WAV 的时长由服务端按 `data.size / byteRate` 算出来的是**精确值**：录音机在 60s
 * 上限处收尾时多补一帧（`data` 块按帧对齐）就会算出 60004ms 之类，正好越过上限被拒。
 * 留 1 秒余量，用户最多录 59 秒，不会出现「录满一分钟反而发不出去」。
 */
const VOICE_RECORD_MAX_MS = MEDIA_MAX_VOICE_DURATION_MS - 1000

/**
 * 收尾事件的宽限（毫秒）：**只用于把「忙」升级成「录音器没响应」这句文案，不用于放行**
 * （#549 收口判据 3）。
 *
 * 正常的收尾窗口是毫秒级（`stop()` → `onStop`）。松手之后 5s 还没有任何收尾事件，就说明
 * 这一段的收尾大概率丢了：能让用户等到的只有「下次再按」，而重按永远不会成功 —— 必须把
 * 「怎么办」说出来。但它**不是**解闸依据：这里没有任何时间判据会把账销掉（判据 4 禁止
 * 任意 TTL 清账），账单只由「收尾事件到了」或「起录被平台拒绝」来销。
 */
const VOICE_RECORD_SETTLE_GRACE_MS = 5_000

/**
 * 这一段是不是已经**远超**「本该收到收尾事件」的时刻。
 *
 * 基线取两者中较晚者：叫过 `stop()` / `abort()` 就是那一刻（收尾本该几毫秒内到）；没叫过
 * 就是「起录时刻 + 录音上限」（录音器最迟在自己录满时收尾）。只喂给文案，不参与解闸。
 */
function settleOverdue(session: VoiceSession, nowMs: number): boolean {
  const dueAtMs = session.stopRequestedAtMs ?? session.startedAtMs + VOICE_RECORD_MAX_MS
  return nowMs - dueAtMs >= VOICE_RECORD_SETTLE_GRACE_MS
}

/**
 * 开始录音（按住说话）。
 *
 * `format: 'wav'`（#359 3b 定案）：微信只提供 mp3 / aac / wav / PCM，其中只有 wav 的
 * RIFF 容器在**真机与开发者工具**上都带 fmt.byteRate / data.size，服务端能精确解析时长；
 * aac 在 Android/开发者工具上落成裸 ADTS（无容器头），iOS 上落成 M4A——同一份代码两种
 * 产物，其中一种必然解析失败。真正的判定仍在 `uploadChatVoice` 里按字节做，这里不押注。
 *
 * `onError`：录音**进行中**失败（最常见的是麦克风权限被拒、设备被占用）时**立刻**上报
 * （#364 审查）。`RecorderManager` 只有 `onError` 这一条失败通道，而它可能在用户**还没
 * 松手**时就到 —— 不在这里上报的话，页面要等到 `stop()` 的 catch 才知道失败，期间按钮
 * 还写着「松开 发送」，用户以为在录、其实什么都没录。
 *
 * `onAutoStop`：录音器**自己停了**（时长上限 / 被系统打断）时的带外通知。`capped` 由
 * 「**此刻**是否仍处于中断态」+「时长是否贴着上限」两件事共同判定，见 `voiceCapped`。
 *
 * `onInterrupted`：被来电 / 视频通话**打断**（`onInterruptionBegin`）时的带外通知，页面据此
 * 放弃这一段并提示重录 —— 中断即「暂停」，暂停之后这段话没被录进去，不能当正常语音发。
 *
 * **抛错**：上一段还没交回收尾事件、录音器仍被它占着时同步抛 `VoiceRecordingBusyError`
 * （与平台 `start()` 失败不同，那一条仍照旧直接抛出，见函数体）。两者都走页面的
 * `catch → 提示`，不会留下「正在录」的假状态。
 */
export function startVoiceRecording(
  onError?: (error: Error) => void,
  onAutoStop?: (recorded: RecordedVoice, capped: boolean) => void,
  onInterrupted?: () => void,
): VoiceRecording {
  /**
   * 闸：录音器一次只录一段（#549）。
   *
   * 上一段还没把自己的收尾事件交回来（`stop()` / `abort()` 已发出、`onStop` / `onError`
   * 还没到）时，**拒绝**新起录 —— 而不是让它叠到同一台录音器上。叠上去之后，每一条不带
   * session id 的回调都只能靠猜属于谁（见 `voiceSession`），F1 就是猜错的那一半。
   *
   * 这里有意的取舍：拒绝是**同步**失败，页面照旧 `catch → 提示`，不会进入「正在录」的假
   * 状态，也不会误发上一段的音频、误复位还在录的那一段。代价是那几十毫秒的收尾窗口里
   * 用户按下的那一次不生效 —— 比起悄悄把两段录音混在一台单例上，这是可解释、可测的行为。
   *
   * 收尾事件**丢了**（平台不再投递）时闸门会一直关着：这是**有意的 fail-closed**（收口判据
   * 3）—— 换一个「猜时间到了就放行」的解闸法，等于把单槽记账要防的「两条回调靠猜归属」
   * 又请回来（判据 4 明确排除任意 TTL）。代价是用户重按不会成功，所以拒绝文案必须说清
   * 怎么办（见 `VoiceRecordingBusyError` 的 `overdue`）。
   */
  if (voiceSession) throw new VoiceRecordingBusyError(settleOverdue(voiceSession, Date.now()))
  const manager = recorder()
  /** 这一段的账：事件到达时按它自己身上记的状态销账。 */
  const session: VoiceSession = {
    resolve: () => undefined,
    reject: () => undefined,
    stopRequested: false,
    abandoned: false,
    interrupted: false,
    startedAtMs: Date.now(),
    stopRequestedAtMs: null,
    onError,
    onAutoStop,
    onInterrupted,
  }
  const done = new Promise<RecordedVoice>((resolve, reject) => {
    session.resolve = resolve
    session.reject = reject
  })
  /**
   * 有 `onError` 时错误已经**带外**上报过了，而用户可能永远不松手（`stop()` 也就不会
   * 被调用）—— 那条 `done` 的 rejection 就没人接，运行时会报「未处理的 Promise 拒绝」。
   * 挂一个空 handler 收掉它；调用方仍然能从 `stop()` 拿到这个 rejection（多个 handler
   * 互不影响），页面自己的提示照旧。
   */
  if (onError) void done.catch(() => undefined)

  voiceSession = session
  try {
    manager.start({
      duration: VOICE_RECORD_MAX_MS,
      format: 'wav',
      sampleRate: 16_000,
      numberOfChannels: 1,
      encodeBitRate: 48_000,
    })
  } catch (error) {
    /*
      `start()` 同步抛错时当场销账。这是**明确假设**，不是平台证据（假设 A2，
      见本文件顶部的「平台假设与端上探针」）：同步抛错表示平台拒绝了这次 start，
      因此不存在「这一段」可供收尾。
      反过来把账留着会让**最常见**的失败（设备忙 / 起录失败）永久关死闸门 —— 那一段本来就
      不会有任何事件来销账，等于把「一次起录失败」变成「进程内再也录不了音」。
      端上探针见本文件顶部「平台假设与端上探针」的 **D7**（记录同步抛错后是否仍收到一次
      onStop / onError）：若真会投，A2 不成立，那段迟到的收尾会被算到下一段头上。
    */
    settleSession(session)
    throw error
  }

  return {
    stop: () => {
      session.stopRequested = true
      session.stopRequestedAtMs = Date.now()
      try {
        manager.stop()
      } catch (error) {
        /*
          失败必须以 **promise** 交出去：同步抛出的话页面 `session.stop().then().catch()`
          这条链根本没建立，异常会一路冒进触摸事件处理（#535 follow-up）。
          但**不许当场销账**（#549 收口判据 1）：同步抛错只说明这条命令没被平台接受，不能据此
          断言「这一段不会再有收尾事件」—— 录音可能还在走（`onStop` 迟早会来），也可能平台
          已经停了、事件还在路上。任一情况下这条收尾事件都会落在下一次起录之后，于是「这条
          回调属于谁」又得靠猜。没有平台证据就 fail-closed：账留着，事件真到了自然销账。
         */
        console.error('[chat-media] 停止录音失败', error)
        return Promise.reject(voiceError(error))
      }
      return done
    },
    abort: () => {
      session.abandoned = true
      session.stopRequested = true
      session.stopRequestedAtMs = Date.now()
      try {
        manager.stop()
      } catch (error) {
        /*
          同上（#549 收口判据 1）：销账等于假定「放弃的这一段也不会再有收尾事件」，而这条
          假定拿不到证据。账留着反而更安全 —— 那一段的 `onStop` 到了会被 `abandoned` 丢掉
          并顺便销账；一直不来就按可见的「录音器没响应」处理。
         */
        console.error('[chat-media] 取消录音失败', error)
      }
    },
    wasInterrupted: () => session.interrupted,
  }
}

/**
 * 录音器自己停时，是不是**录到时长上限**（而不是被系统打断，#535 复审 medium）。
 *
 * 只按时长判据的话，59s 上限前最后 500ms 里被打断的半句会被当成「录满」自动发给对方。
 * 平台有真正的信号（`onInterruptionBegin`：来电 / 视频通话占用麦克风），**此刻仍处于中断态**
 * 的那一段一律不算录满；`- 500ms` 的余量留给录音机按帧对齐收尾时回报的时长略小于配置值。
 *
 * 判据只读**当前**中断态（`onInterruptionEnd` 就清零），**不**改成「中断过一次就永久不算
 * 录满」（#549 收口判据 2）：一次中断已经恢复、之后正常录满 59s 的那一段，用户要的是发送，
 * 把它判成「被打断」不发等于拿历史标记吃掉一次完整录音。中断结束之后剩下的风险（暂停期间
 * 音频是否缺一段）属于平台语义，登记为本文件顶部「平台假设与端上探针」的 **D4**（记录
 * interruptionBegin / onPause / onInterruptionEnd / onStop 的实际顺序与 duration），
 * 不由时间 / 历史标记去猜。
 */
function voiceCapped(session: VoiceSession, recorded: RecordedVoice): boolean {
  if (session.interrupted) return false
  return recorded.durationMs >= VOICE_RECORD_MAX_MS - 500
}

/**
 * 麦克风权限被拒（与「录音失败，请重试」分开，见 `voiceError`）。
 *
 * 页面据此给「去设置」入口（`Taro.openSetting`，与扫码页的相机权限同一范式）：
 * 权限没开时再点多少次「重试」都只会失败，只提示一句「录音失败」等于把用户困在原地。
 */
export class VoicePermissionError extends Error {
  constructor() {
    super('需要麦克风权限才能发语音')
    this.name = 'VoicePermissionError'
  }
}

/**
 * 上一段录音还没交回收尾事件，录音器仍被它占着（`#549`）：此刻起录被拒绝。
 *
 * 与 `VoicePermissionError` 分开：这**不是失败**，而是「稍后再按」—— 页面照旧提示，
 * 但不必把用户送去设置页。文案要说清是「上一段还在收尾」，否则用户只会看到
 * 「录音失败，请重试」并以为功能坏了。
 *
 * `overdue=true`（收尾事件很可能已经丢了，见 `settleOverdue`）：同样的拒绝，但「稍后再按」
 * 在下一次、下下一次都不会成功 —— 这时必须给出可执行的恢复动作。闸门本身仍然关着
 * （fail-closed，不拿时间当解闸依据），改的只是**这句话**。
 */
export class VoiceRecordingBusyError extends Error {
  /** 这一段的收尾已远超预期（文案因此要给恢复动作），与「正在收尾」区分开 */
  readonly overdue: boolean

  constructor(overdue = false) {
    super(
      overdue
        ? '录音器没有响应，请关闭小程序后重新打开再试'
        : '上一段录音还在收尾，请稍后再按住说话',
    )
    this.name = 'VoiceRecordingBusyError'
    this.overdue = overdue
  }
}

export class VoicePrivacyError extends Error {
  constructor() {
    super('请先同意《用户隐私保护指引》后重试')
    this.name = 'VoicePrivacyError'
  }
}

/**
 * 录音容器不在契约白名单里（#516）。
 *
 * 页面只展示短文案；`sizeBytes` / `header` 留给日志与真机取证 —— 微信 toast 超过约 70
 * 个字符会被截断，把 hex 拼进用户可见文案既看不清也占地方。
 */
export class VoiceContainerError extends Error {
  readonly sizeBytes: number
  readonly header: string

  constructor(sizeBytes: number, header: string) {
    super('当前录音格式暂不支持发送语音')
    this.name = 'VoiceContainerError'
    this.sizeBytes = sizeBytes
    this.header = header
  }
}

/**
 * 对象存储 PUT 失败（#516）。
 *
 * 用户文案保持通用（不把 HTTP 状态码塞进 toast），`statusCode` 保留给日志与调用方排查。
 */
export class MediaUploadError extends Error {
  readonly statusCode: number

  constructor(kind: MediaKind, statusCode: number) {
    super(`${kind === 'IMAGE' ? '图片' : '语音'}发送失败，请重试`)
    this.name = 'MediaUploadError'
    this.statusCode = statusCode
  }
}

/** 录音失败文案：权限被拒要给「去设置」，其它给可重试的提示。 */
export function voiceError(error: unknown): Error {
  /**
   * 已经是归一化过的权限错误就**原样返回**（#364 审查回合二）。
   *
   * 这条路径会被走两遍：`RecorderManager.onError` 先经这里归一化成 `VoicePermissionError`
   * 再由 `startVoiceRecording` 带外上报给页面，页面拿到后还会再调一次本函数。而
   * `VoicePermissionError` 是普通 `Error` 子类、没有 `errMsg` —— 二次归一化会把它降级成
   * 「录音失败，请重试」，页面的 `instanceof VoicePermissionError` 判据从此恒假，
   * 「去设置」入口（`getSetting` → `openSetting`）永远进不去，用户只能反复看到通用文案。
   *
   * `VoiceRecordingBusyError` 同理（#549）：它自己的文案就是给用户看的，不能被降级。
   */
  if (
    error instanceof VoicePermissionError ||
    error instanceof VoicePrivacyError ||
    error instanceof VoiceRecordingBusyError
  ) {
    return error
  }
  const message =
    typeof error === 'object' && error !== null && 'errMsg' in error
      ? String((error as { errMsg?: unknown }).errMsg ?? '')
      : ''
  if (/privacy/i.test(message)) return new VoicePrivacyError()
  if (/auth|permission|scope/i.test(message)) {
    return new VoicePermissionError()
  }
  return new Error('录音失败，请重试')
}

// ---------------------------------------------------------------------------
// 本地文件读取
// ---------------------------------------------------------------------------

/**
 * 把读到的内容收敛成 ArrayBuffer。
 *
 * **不能只写 `data instanceof ArrayBuffer`**：开发者工具里这个对象可能来自另一个 realm，
 * `instanceof` 会是 false（对象本身是好的），于是把「读成功」误报成「读取失败」。
 */
function toArrayBuffer(data: unknown): ArrayBuffer | null {
  if (data instanceof ArrayBuffer) return data
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  }
  if (Object.prototype.toString.call(data) === '[object ArrayBuffer]') return data as ArrayBuffer
  return null
}

/**
 * 读本地文件为二进制。
 *
 * 优先异步 `readFile`（**不传 encoding**：传 utf8 会把二进制读坏），失败或拿到的不是
 * 二进制时退到 `readFileSync` —— 开发工具与真机上「异步读临时文件偶发失败」是已知现象。
 */
function readLocalFile(path: string, failText: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const fs = Taro.getFileSystemManager()

    const accept = (raw: unknown, via: string): boolean => {
      const buffer = toArrayBuffer(raw)
      if (buffer) {
        resolve(buffer)
        return true
      }
      console.error(`[chat-media] ${via} 读到的不是二进制内容`, typeof raw)
      return false
    }

    const readSync = () => {
      try {
        if (!accept(fs.readFileSync(path), 'readFileSync')) reject(new Error(failText))
      } catch (error) {
        console.error('[chat-media] readFileSync 失败', error)
        reject(new Error(failText))
      }
    }

    try {
      fs.readFile({
        filePath: path,
        success: (res) => {
          if (!accept(res.data, 'readFile')) readSync()
        },
        fail: (error) => {
          console.error('[chat-media] readFile 失败', error?.errMsg)
          readSync()
        },
      })
    } catch (error) {
      console.error('[chat-media] readFile 抛异常', error)
      readSync()
    }
  })
}
