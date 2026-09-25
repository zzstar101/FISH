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
  type ChatImageMime,
  imageRejectReason,
  mediaObjectUrl,
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
 * **只有用户取消**才当「没选」返回空数组（否则每次取消都会弹一个吓人的错误）；
 * 权限被拒 / 相机异常 / 平台失败一律抛出可展示的错误，由页面提示并让用户重试。
 */
export async function pickChatImages(limit: number): Promise<ChatImagePick> {
  if (limit <= 0) return { images: [], rejected: null }

  let result: Taro.chooseMedia.SuccessCallbackResult
  try {
    result = await Taro.chooseMedia({
      count: limit,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      // compressed：iOS 相册原图常是 HEIC，压缩后通常是 JPG，能直接过契约白名单
      sizeType: ['compressed'],
    })
  } catch (error) {
    if (isChooseMediaCancel(error)) return { images: [], rejected: null }
    throw new Error('无法选择图片，请检查相册/相机权限后重试')
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

/** 上传单张图片，返回 create 需要的声明值（`sizeBytes` = 真实字节长度）。 */
export async function uploadChatImage(
  conversationId: string,
  image: PickedChatImage,
): Promise<UploadedImage> {
  const buffer = await readLocalFile(image.path, '图片读取失败，请重试')
  const objectKey = await putObject(conversationId, 'IMAGE', image.mime, buffer)
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
 * 容器由**字节头**判定（不信任录音机声明的格式）：契约只接受可解析时长的 WebM / MP4，
 * 认不出来就明确报错，而不是发一个必然 422 的请求让用户看到「媒体实际属性与声明不一致」。
 */
export async function uploadChatVoice(
  conversationId: string,
  voice: RecordedVoice,
): Promise<UploadedVoice> {
  const buffer = await readLocalFile(voice.path, '语音读取失败，请重试')
  const contentType: VoiceMime | null = voiceMimeFromBytes(buffer)
  if (!contentType) throw new Error('当前录音格式暂不支持发送语音')
  const objectKey = await putObject(conversationId, 'VOICE', contentType, buffer)
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
): Promise<string> {
  const presign: MediaPresignResponse = mediaPresignResponseSchema.parse(
    await apiRequest(CHAT_ROUTES.mediaPresign(conversationId), {
      method: 'POST',
      body: { kind, contentType, sizeBytes: buffer.byteLength },
    }),
  )

  const uploaded = await Taro.request({
    url: presign.uploadUrl,
    method: 'PUT',
    data: buffer,
    // `presign.headers` 当前是空对象（见文件头注释 1），必须显式带上 content-type
    header: { ...presign.headers, 'content-type': contentType },
    timeout: UPLOAD_TIMEOUT_MS,
  })
  if (uploaded.statusCode < 200 || uploaded.statusCode >= 300) {
    throw new Error(kind === 'IMAGE' ? '图片发送失败，请重试' : '语音发送失败，请重试')
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
 */
export async function downloadChatMedia(conversationId: string, mediaId: string): Promise<string> {
  const cached = localMediaPaths.get(mediaId)
  if (cached) return cached

  const result = await Taro.downloadFile({
    url: mediaObjectUrl(API_BASE, conversationId, mediaId),
    header: { Cookie: sessionCookieHeader() },
    timeout: DOWNLOAD_TIMEOUT_MS,
  })
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error('媒体加载失败')
  }
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

type VoiceRecorder = ReturnType<typeof Taro.getRecorderManager>

/**
 * `RecorderManager` 是**全局单例**，`onStop/onError` 注册会一直累积，所以这里只注册一次，
 * 由模块级 `voiceHandlers` 指向「当前这一次录音」。不这么做的话第二次录音会同时触发
 * 上一次遗留的回调（表现为重复发送 / 状态错乱）。
 */
let voiceRecorder: VoiceRecorder | null = null
let voiceHandlers: {
  resolve: (voice: RecordedVoice) => void
  reject: (error: Error) => void
} | null = null

function recorder(): VoiceRecorder {
  if (voiceRecorder) return voiceRecorder
  const manager = Taro.getRecorderManager()
  manager.onStop((result) => {
    const handlers = voiceHandlers
    voiceHandlers = null
    handlers?.resolve({
      path: result.tempFilePath,
      durationMs: Math.max(0, Math.round(result.duration)),
    })
  })
  manager.onError((error) => {
    const handlers = voiceHandlers
    voiceHandlers = null
    handlers?.reject(voiceError(error))
  })
  voiceRecorder = manager
  return manager
}

export type VoiceRecording = {
  /** 结束录音并等 `onStop`（拿到临时文件与时长） */
  stop: () => Promise<RecordedVoice>
  /** 放弃这次录音（不 resolve、不 reject，也不弹错） */
  abort: () => void
}

/**
 * 开始录音（按住说话）。
 *
 * `format: 'aac'`：微信只提供 mp3 / aac / wav / PCM，其中只有 aac 的产物可能是契约接受的
 * 容器（iOS 上是 M4A/MP4）。真正的判定在 `uploadChatVoice` 里按字节做，所以这里不押注格式。
 */
export function startVoiceRecording(): VoiceRecording {
  const manager = recorder()
  const done = new Promise<RecordedVoice>((resolve, reject) => {
    voiceHandlers = { resolve, reject }
  })

  manager.start({
    duration: MEDIA_MAX_VOICE_DURATION_MS,
    format: 'aac',
    sampleRate: 16_000,
    numberOfChannels: 1,
    encodeBitRate: 48_000,
  })

  return {
    stop: () => {
      manager.stop()
      return done
    },
    abort: () => {
      voiceHandlers = null
      try {
        manager.stop()
      } catch (error) {
        console.error('[chat-media] 取消录音失败', error)
      }
    },
  }
}

/** 录音失败文案：权限被拒要给「去设置」，其它给可重试的提示。 */
export function voiceError(error: unknown): Error {
  const message =
    typeof error === 'object' && error !== null && 'errMsg' in error
      ? String((error as { errMsg?: unknown }).errMsg ?? '')
      : ''
  if (/auth|permission|scope/i.test(message)) {
    return new Error('需要麦克风权限才能发语音')
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
