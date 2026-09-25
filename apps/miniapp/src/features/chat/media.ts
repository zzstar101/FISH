/**
 * 会话媒体的纯逻辑（#67 第四步：先图片、后语音）。
 *
 * **不 import Taro**：这些判据要在 bun 测试里直接跑（与 `features/upload/mime.ts` 同一取舍）。
 * 平台层（选图、录音、直传、下载）在 `./media-api.ts`。
 */
import { CHAT_ROUTES } from '@fish/contracts/chat/routes'
import type { MEDIA_IMAGE_MIME, MEDIA_VOICE_MIME } from '@fish/contracts/chat/schema'

/** 契约白名单里的图片 mime（与会话媒体的 `MEDIA_IMAGE_MIME` 同源）。 */
export type ChatImageMime = (typeof MEDIA_IMAGE_MIME)[number]

/** 契约白名单里的语音 mime。 */
export type VoiceMime = (typeof MEDIA_VOICE_MIME)[number]

/**
 * 一次最多挑几张图。
 *
 * 比微信 `chooseMedia` 上限（9）小没有意义，取 9；真正的约束是单张 5MB（契约）。
 */
export const MEDIA_IMAGE_PICK_LIMIT = 9

/**
 * 服务端 `stat.size` 只等于这里报出去的那个数，所以 `sizeBytes` 必须来自**读出来的字节长度**。
 * 这条注释是给未来改代码的人看的：不要换成 `chooseMedia` 的 `file.size`。
 */
export const MEDIA_IMAGE_MAX_BYTES = 5 * 1024 * 1024

/** 从字节头判语音容器。 */
export function voiceMimeFromBytes(buffer: ArrayBuffer): VoiceMime | null {
  const bytes = new Uint8Array(buffer)
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp') return 'audio/mp4'
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return 'audio/webm'
  }
  return null
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  let out = ''
  for (let index = from; index < to; index += 1) out += String.fromCharCode(bytes[index] ?? 0)
  return out
}

/** 选图时的本地预检：返回文案即不能发，`null` 即通过（服务端仍会按真实字节再拦一次）。 */
export function imageRejectReason(sizeBytes: number): string | null {
  if (sizeBytes > MEDIA_IMAGE_MAX_BYTES) return '单张图片不能超过 5MB'
  return null
}

/**
 * 语音气泡上的时长文案。
 *
 * 服务端会按字节重解析真实时长并覆盖声明值，所以这里**只用于本地乐观态**；
 * 服务端 DTO 到手后一律以 `durationMs` 为准。最少显示 1″，避免 <500ms 的短按显示成 0″。
 */
export function voiceDurationLabel(durationMs: number | null | undefined): string {
  if (!durationMs || durationMs <= 0) return '1″'
  return `${Math.max(1, Math.ceil(durationMs / 1000))}″`
}

/**
 * 私有媒体的下载地址（验收⑤：不拼公开对象存储地址）。
 *
 * `MediaMessageDto.url` 是 Web 形态的 `/api/conversations/...`（给浏览器同源代理用），
 * 小程序没有那层代理，必须用 `CHAT_ROUTES.mediaObject` + `API_BASE` 自己拼，
 * 再经 `downloadFile` 带上会话 Cookie 取（`<Image src>` 带不了 Cookie）。
 */
export function mediaObjectUrl(apiBase: string, conversationId: string, mediaId: string): string {
  const base = apiBase.replace(/\/+$/, '')
  return `${base}${CHAT_ROUTES.mediaObject(conversationId, mediaId)}`
}

/**
 * 多步媒体链「起步时的身份已经不在了」的中止信号（#67 复查 #222）。
 *
 * 与普通上传失败分开：调用方据此**什么都不做**（既不写状态也不提示），因为这次上传 /
 * 下载已经不属于当前账号、当前这次进入 —— 复用失败文案只会让用户看到一条莫名其妙的报错。
 * 与 `features/upload/active.ts` 的 `UploadAbortedError` 同一手法（那个模块服务于出物页）。
 */
export class MediaAbortedError extends Error {
  constructor() {
    super('媒体操作已中止')
    this.name = 'MediaAbortedError'
  }
}

/**
 * 多步链每一步发请求前的在途检查。
 *
 * 为什么必须逐步检查：调用方手里的 `isStale()` 只在整条链**返回之后**跑，那是写状态的守卫；
 * 而这条链是「读文件 → presign → 直传 PUT → create」（下载侧是「downloadFile → 写缓存」），
 * 后一步会照常发出。`lib/request.ts` 的 Cookie 是**调用那一刻**从会话现取的，所以切号后
 * create 会带着**新账号**的会话落库，PUT 还会在对象存储里留下一个没人引用的对象，
 * 下载则会把上一个身份的私有媒体临时文件写进模块缓存给下一个身份复用。
 *
 * 要不要取消正在飞的那一次？`Taro.request` / `Taro.downloadFile` 没接 AbortController，
 * 做不到 —— 这里只保证「还没发的、以及回来之后要落地的」不再发生。传 `undefined`
 * （不关心归属）时保持旧行为。
 */
export function assertMediaActive(isActive?: () => boolean): void {
  if (isActive && !isActive()) throw new MediaAbortedError()
}
