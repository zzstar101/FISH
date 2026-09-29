import {
  MEDIA_IMAGE_MIME,
  MEDIA_MAX_IMAGE_BYTES,
  MEDIA_MAX_IMAGE_DIMENSION,
  MEDIA_MAX_VOICE_BYTES,
  MEDIA_MAX_VOICE_DURATION_MS,
  MEDIA_VOICE_MIME,
  type MediaKind,
} from '@fish/contracts/chat/schema'

/** 与契约白名单同源，避免前端 accept 与后端校验各写一份。 */
export const IMAGE_FILE_ACCEPT = MEDIA_IMAGE_MIME.join(',')
export const VOICE_FILE_ACCEPT = MEDIA_VOICE_MIME.join(',')

/** 浏览器不给 MIME（`file.type === ''`）时的回退表；与 publish/api.ts 同一口径。 */
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}
const VOICE_MIME_BY_EXTENSION: Record<string, string> = {
  webm: 'audio/webm',
  mp4: 'audio/mp4',
  m4a: 'audio/mp4',
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/**
 * 解析上传/落库要声明的 MIME。
 *
 * 只有浏览器**给不出** `file.type` 时才按扩展名回退：MIME 明确但不允许的（例如 PDF 改名
 * `.jpg`）绝不靠扩展名洗白 —— 与 `publish/api.ts` 的 `allowedMime` 同一条规则。
 */
export function resolveMediaContentType(
  kind: MediaKind,
  file: Pick<File, 'type' | 'name'>,
): string | null {
  const allowed: readonly string[] = kind === 'IMAGE' ? MEDIA_IMAGE_MIME : MEDIA_VOICE_MIME
  if (file.type !== '') return allowed.includes(file.type) ? file.type : null
  const byExtension = kind === 'IMAGE' ? IMAGE_MIME_BY_EXTENSION : VOICE_MIME_BY_EXTENSION
  return byExtension[extensionOf(file.name)] ?? null
}

/** 待上传的媒体载荷：只带服务端校验需要的字段，不含 UI 用的预览 URL。 */
export type ImageUploadDraft = {
  kind: 'IMAGE'
  file: File
  width: number
  height: number
}
export type VoiceUploadDraft = {
  kind: 'VOICE'
  file: File
  durationMs: number
}
export type MediaUploadDraft = ImageUploadDraft | VoiceUploadDraft

/**
 * 客户端初筛（mime + 体积）。只负责在进 outbox 之前给出可读反馈，
 * 真实字节、尺寸、时长一律以服务端探测结果为准（见 media-service.ts）。
 */
export function describeMediaFileRejection(
  kind: MediaKind,
  file: Pick<File, 'type' | 'size' | 'name'>,
): string | null {
  const maxBytes = kind === 'IMAGE' ? MEDIA_MAX_IMAGE_BYTES : MEDIA_MAX_VOICE_BYTES
  if (file.size <= 0) return '文件为空，请重新选择'
  if (resolveMediaContentType(kind, file) === null) {
    return kind === 'IMAGE' ? '仅支持 JPG / PNG / WebP 图片' : '仅支持 WebM / MP4 语音'
  }
  if (file.size > maxBytes) {
    return kind === 'IMAGE' ? '图片不能超过 5MB' : '语音不能超过 10MB'
  }
  return null
}

export function describeImageDimensionRejection(width: number, height: number): string | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return '无法读取图片尺寸，请换一张'
  }
  if (width > MEDIA_MAX_IMAGE_DIMENSION || height > MEDIA_MAX_IMAGE_DIMENSION) {
    return `图片边长不能超过 ${MEDIA_MAX_IMAGE_DIMENSION}px`
  }
  return null
}

export function describeVoiceDurationRejection(durationMs: number): string | null {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '录音时长无效，请重新录制'
  if (durationMs > MEDIA_MAX_VOICE_DURATION_MS) return '语音不能超过 60 秒'
  return null
}

/** 语音气泡上的时长文案，如 `12″`。 */
export function formatVoiceDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs <= 0) return ''
  return `${Math.max(1, Math.round(durationMs / 1000))}″`
}

/**
 * 图片"真实尺寸"= **容器里的原始宽高**，与服务端
 * `apps/api/src/modules/messages/media-probe.ts` 的 `probeImage` 逐条对齐。
 *
 * 不能用 `createImageBitmap` / `<img>`：浏览器解码一律按 EXIF 方向旋转（实测 Chromium 连
 * `{ imageOrientation: 'none' }` 都忽略，`naturalWidth` 同样是旋转后的值），而服务端只读
 * 容器结构。手机竖拍照片（Orientation 6/8）两边会差一个宽高互换，上传必然 422 且无法重试。
 * 因此这里只做零依赖的容器解析，不依赖任何浏览器解码行为。
 *
 * 服务端改动时这里必须同步（`media-probe.test.ts` 是真源）。
 */
function u16be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0)
}

function u16le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)
}

function u24le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16)
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  )
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  )
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = ''
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i] ?? 0)
  return out
}

/** PNG：8 字节签名 + IHDR（length(4) + "IHDR" + width(4) + height(4)）。 */
function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (bytes.length < 24) return null
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[i] !== signature[i]) return null
  }
  if (u32be(bytes, 8) !== 13 || ascii(bytes, 12, 4) !== 'IHDR') return null
  if (bytes.length < 33) return null
  const width = u32be(bytes, 16)
  const height = u32be(bytes, 20)
  if (width === 0 || height === 0) return null
  return { width, height }
}

/** JPEG：扫 marker 到 SOFn（C0–CF 去掉 C4/C8/CC），SOF 里是**原始**宽高（不看 EXIF）。 */
function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null
    const marker = bytes[offset + 1] ?? 0
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2
      continue
    }
    if (offset + 4 > bytes.length) return null
    const segmentLength = u16be(bytes, offset + 2)
    if (segmentLength < 2 || offset + 2 + segmentLength > bytes.length) return null
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      if (segmentLength < 8 || offset + 9 > offset + 2 + segmentLength) return null
      const components = bytes[offset + 9] ?? 0
      if (components === 0 || segmentLength < 8 + components * 3) return null
      const width = u16be(bytes, offset + 7)
      const height = u16be(bytes, offset + 5)
      if (width === 0 || height === 0) return null
      return { width, height }
    }
    offset += 2 + segmentLength
  }
  return null
}

/** WebP：VP8（有损）/ VP8L（无损）/ VP8X（扩展画布）。 */
function webpSize(bytes: Uint8Array): { width: number; height: number } | null {
  const riffSize = u32le(bytes, 4)
  if (bytes.length < 12 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') {
    return null
  }
  if (riffSize < 4 || riffSize > bytes.length - 8) return null
  const riffEnd = 8 + riffSize
  let offset = 12
  while (offset < riffEnd) {
    if (offset + 8 > riffEnd) return null
    const fourCc = ascii(bytes, offset, 4)
    const chunkSize = u32le(bytes, offset + 4)
    const paddedEnd = offset + 8 + chunkSize + (chunkSize & 1)
    if (paddedEnd > riffEnd) return null
    if (fourCc === 'VP8 ') {
      if (chunkSize < 10) return null
      const width = u16le(bytes, offset + 14)
      const height = u16le(bytes, offset + 16)
      if (width === 0 || height === 0) return null
      return { width, height }
    }
    if (fourCc === 'VP8L') {
      if (chunkSize < 5) return null
      const b1 = bytes[offset + 9] ?? 0
      const b2 = bytes[offset + 10] ?? 0
      const b3 = bytes[offset + 11] ?? 0
      const b4 = bytes[offset + 12] ?? 0
      const width = (b1 | ((b2 & 0x3f) << 8)) + 1
      const height = (((b2 >> 6) & 0x3) | (b3 << 2) | ((b4 & 0x0f) << 10)) + 1
      return { width, height }
    }
    if (fourCc === 'VP8X') {
      if (chunkSize < 10) return null
      const width = u24le(bytes, offset + 12) + 1
      const height = u24le(bytes, offset + 15) + 1
      return { width, height }
    }
    offset = paddedEnd
  }
  return null
}

/** 按容器结构解析真实宽高；解析不了返回 null（调用方拒绝发送，不猜）。 */
export function probeImageSizeFromBytes(
  bytes: Uint8Array,
  contentType: string,
): { width: number; height: number } | null {
  if (contentType === 'image/png') return pngSize(bytes)
  if (contentType === 'image/jpeg') return jpegSize(bytes)
  if (contentType === 'image/webp') return webpSize(bytes)
  return null
}

/** 读整个文件（≤5MB）后解析容器尺寸——上传的是同一份字节，口径必须与服务端一致。 */
export async function probeImageSize(
  file: File,
  contentType: string,
): Promise<{ width: number; height: number } | null> {
  return probeImageSizeFromBytes(new Uint8Array(await file.arrayBuffer()), contentType)
}

export type VoiceRecording = { file: File; durationMs: number }

/** 录完返回的句柄：`stop` 收尾并释放麦克风，`cancel` 只释放不产出。 */
export type VoiceRecorder = {
  stop: () => Promise<VoiceRecording>
  cancel: () => void
}

/** 契约只接受可解析容器时长的 WebM / MP4，按浏览器支持度择优。 */
export const VOICE_RECORDER_MIME_CANDIDATES = ['audio/webm', 'audio/mp4'] as const
export type VoiceRecorderMime = (typeof VOICE_RECORDER_MIME_CANDIDATES)[number]

export function pickVoiceRecorderMime(
  isTypeSupported: (mime: string) => boolean,
): VoiceRecorderMime | null {
  for (const mime of VOICE_RECORDER_MIME_CANDIDATES) {
    if (isTypeSupported(mime)) return mime
  }
  return null
}

function voiceFileExtension(mime: VoiceRecorderMime): string {
  return mime === 'audio/webm' ? 'webm' : 'm4a'
}

/**
 * 开始录音。不支持 `MediaRecorder` / 麦克风权限被拒时抛错，由调用方转成可读提示。
 * 时长按录音起止的单调时钟计，服务端仍会自己探真实时长（声明值不参与落库）。
 */
export async function startVoiceRecording(): Promise<VoiceRecorder> {
  if (typeof MediaRecorder === 'undefined' || navigator.mediaDevices?.getUserMedia === undefined) {
    throw new Error('当前浏览器不支持录音，请改用支持的浏览器')
  }
  const mime = pickVoiceRecorderMime((candidate) => MediaRecorder.isTypeSupported(candidate))
  if (mime === null) throw new Error('当前浏览器不支持 WebM / MP4 录音')

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const release = () => {
    for (const track of stream.getTracks()) track.stop()
  }
  try {
    const chunks: BlobPart[] = []
    const recorder = new MediaRecorder(stream, { mimeType: mime })
    const startedAt = performance.now()
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    }
    recorder.start()

    return {
      stop: () =>
        new Promise<VoiceRecording>((resolve, reject) => {
          recorder.onerror = () => reject(new Error('录音失败，请重试'))
          recorder.onstop = () => {
            release()
            const blob = new Blob(chunks, { type: mime })
            const durationMs = Math.max(1, Math.round(performance.now() - startedAt))
            resolve({
              file: new File([blob], `voice-${Date.now()}.${voiceFileExtension(mime)}`, {
                type: mime,
              }),
              durationMs,
            })
          }
          recorder.stop()
        }),
      cancel: () => {
        try {
          if (recorder.state !== 'inactive') recorder.stop()
        } catch {
          // 已经停止 / 已被回收：忽略，下面仍要释放麦克风轨道。
        }
        release()
      },
    }
  } catch (error) {
    release()
    throw error
  }
}
