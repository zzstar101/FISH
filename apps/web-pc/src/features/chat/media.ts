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
  file: Pick<File, 'type' | 'size'>,
): string | null {
  const allowed: readonly string[] = kind === 'IMAGE' ? MEDIA_IMAGE_MIME : MEDIA_VOICE_MIME
  const maxBytes = kind === 'IMAGE' ? MEDIA_MAX_IMAGE_BYTES : MEDIA_MAX_VOICE_BYTES
  if (file.size <= 0) return '文件为空，请重新选择'
  if (!allowed.includes(file.type)) {
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
 * 读真实像素尺寸：服务端会拿它和图片内容比对（不一致直接 422），
 * 因此必须来自解码后的位图，不能用 File 的任何声明值。
 */
export async function probeImageSize(
  file: File,
): Promise<{ width: number; height: number } | null> {
  if (typeof createImageBitmap !== 'function') return null
  let bitmap: ImageBitmap | null = null
  try {
    bitmap = await createImageBitmap(file)
    return { width: bitmap.width, height: bitmap.height }
  } catch {
    return null
  } finally {
    bitmap?.close()
  }
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
