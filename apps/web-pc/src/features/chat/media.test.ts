import { afterEach, describe, expect, test } from 'bun:test'
import {
  describeImageDimensionRejection,
  describeMediaFileRejection,
  describeVoiceDurationRejection,
  formatVoiceDuration,
  pickVoiceRecorderMime,
  probeImageSize,
  probeImageSizeFromBytes,
  resolveMediaContentType,
  startVoiceRecording,
  VOICE_RECORDER_MIME_CANDIDATES,
} from './media'

function file(
  type: string,
  size: number,
  name = 'sample.bin',
): Pick<File, 'type' | 'size' | 'name'> {
  return { type, size, name }
}

const globals = globalThis as Record<string, unknown>
const originalCreateImageBitmap = globals.createImageBitmap
const originalMediaRecorder = globals.MediaRecorder
const originalMediaDevices = (navigator as { mediaDevices?: unknown }).mediaDevices

afterEach(() => {
  globals.createImageBitmap = originalCreateImageBitmap
  globals.MediaRecorder = originalMediaRecorder
  Object.defineProperty(navigator, 'mediaDevices', {
    value: originalMediaDevices,
    configurable: true,
    writable: true,
  })
})

describe('media file pre-checks', () => {
  test('accepts the contract mime/byte window and rejects everything else', () => {
    expect(describeMediaFileRejection('IMAGE', file('image/png', 1_024))).toBeNull()
    expect(describeMediaFileRejection('IMAGE', file('image/jpeg', 5 * 1024 * 1024))).toBeNull()
    expect(describeMediaFileRejection('IMAGE', file('image/gif', 1_024))).toBe(
      '仅支持 JPG / PNG / WebP 图片',
    )
    expect(describeMediaFileRejection('IMAGE', file('image/png', 5 * 1024 * 1024 + 1))).toBe(
      '图片不能超过 5MB',
    )
    expect(describeMediaFileRejection('IMAGE', file('image/png', 0))).toBe('文件为空，请重新选择')

    expect(describeMediaFileRejection('VOICE', file('audio/webm', 1_024))).toBeNull()
    expect(describeMediaFileRejection('VOICE', file('audio/mp4', 1_024))).toBeNull()
    expect(describeMediaFileRejection('VOICE', file('audio/mpeg', 1_024))).toBe(
      '仅支持 WebM / MP4 语音',
    )
    expect(describeMediaFileRejection('VOICE', file('audio/webm', 10 * 1024 * 1024 + 1))).toBe(
      '语音不能超过 10MB',
    )
  })

  test('falls back to the extension only when the browser reports no mime', () => {
    // 浏览器不给 MIME：按扩展名回退（与 publish/api.ts 的 allowedMime 同一口径）。
    expect(resolveMediaContentType('IMAGE', file('', 1_024, 'IMG_0001.JPG'))).toBe('image/jpeg')
    expect(resolveMediaContentType('IMAGE', file('', 1_024, 'shot.png'))).toBe('image/png')
    expect(resolveMediaContentType('VOICE', file('', 1_024, 'voice.m4a'))).toBe('audio/mp4')
    expect(describeMediaFileRejection('IMAGE', file('', 1_024, 'shot.webp'))).toBeNull()

    // MIME 明确但不允许时绝不靠扩展名洗白。
    expect(resolveMediaContentType('IMAGE', file('application/pdf', 1_024, 'evil.jpg'))).toBeNull()
    expect(resolveMediaContentType('VOICE', file('text/plain', 1_024, 'evil.webm'))).toBeNull()
    expect(describeMediaFileRejection('IMAGE', file('application/pdf', 1_024, 'evil.jpg'))).toBe(
      '仅支持 JPG / PNG / WebP 图片',
    )

    // 既没有 MIME 也没有已知扩展名：拒绝。
    expect(resolveMediaContentType('IMAGE', file('', 1_024, 'noext'))).toBeNull()
    expect(resolveMediaContentType('IMAGE', file('', 1_024, 'archive.zip'))).toBeNull()
  })

  test('rejects out-of-range image dimensions and voice durations', () => {
    expect(describeImageDimensionRejection(4096, 4096)).toBeNull()
    expect(describeImageDimensionRejection(4097, 100)).toBe('图片边长不能超过 4096px')
    expect(describeImageDimensionRejection(100, 0)).toBe('无法读取图片尺寸，请换一张')
    expect(describeImageDimensionRejection(Number.NaN, 100)).toBe('无法读取图片尺寸，请换一张')

    expect(describeVoiceDurationRejection(60_000)).toBeNull()
    expect(describeVoiceDurationRejection(60_001)).toBe('语音不能超过 60 秒')
    expect(describeVoiceDurationRejection(0)).toBe('录音时长无效，请重新录制')
  })

  test('formats voice durations for the bubble label', () => {
    expect(formatVoiceDuration(1_500)).toBe('2″')
    expect(formatVoiceDuration(60_000)).toBe('60″')
    expect(formatVoiceDuration(null)).toBe('')
    expect(formatVoiceDuration(0)).toBe('')
  })
})

describe('voice recorder mime selection', () => {
  test('prefers WebM and falls back to MP4, in contract whitelist order', () => {
    expect(VOICE_RECORDER_MIME_CANDIDATES).toEqual(['audio/webm', 'audio/mp4'])
    expect(pickVoiceRecorderMime(() => true)).toBe('audio/webm')
    expect(pickVoiceRecorderMime((mime) => mime === 'audio/mp4')).toBe('audio/mp4')
    expect(pickVoiceRecorderMime(() => false)).toBeNull()
  })
})

describe('probeImageSize（容器原始宽高）', () => {
  test('PNG 读 IHDR，截断/异格式返回 null（不猜）', () => {
    expect(probeImageSizeFromBytes(pngBytes(320, 240), 'image/png')).toEqual({
      width: 320,
      height: 240,
    })
    expect(probeImageSizeFromBytes(pngBytes(320, 240).subarray(0, 20), 'image/png')).toBeNull()
    expect(probeImageSizeFromBytes(pngBytes(320, 240), 'image/jpeg')).toBeNull()
    expect(probeImageSizeFromBytes(new Uint8Array([1, 2, 3, 4]), 'image/png')).toBeNull()
  })

  test('JPEG 读 SOFn 原始宽高，不受 EXIF Orientation 影响', () => {
    // 手机竖拍：容器里是 320x240 + Orientation=6（浏览器解码后会变成 240x320）。
    const rotated = jpegBytes(320, 240, 6)
    expect(probeImageSizeFromBytes(rotated, 'image/jpeg')).toEqual({ width: 320, height: 240 })
    expect(probeImageSizeFromBytes(jpegBytes(320, 240, 1), 'image/jpeg')).toEqual({
      width: 320,
      height: 240,
    })
    // 非 JPEG / 截断的字节一律 null。
    expect(probeImageSizeFromBytes(rotated.subarray(0, 3), 'image/jpeg')).toBeNull()
    expect(probeImageSizeFromBytes(rotated, 'image/webp')).toBeNull()
  })

  test('WebP 读 VP8X / VP8L / VP8 三种容器', () => {
    expect(probeImageSizeFromBytes(webpVp8xBytes(320, 240), 'image/webp')).toEqual({
      width: 320,
      height: 240,
    })
    expect(probeImageSizeFromBytes(webpVp8lBytes(320, 240), 'image/webp')).toEqual({
      width: 320,
      height: 240,
    })
    expect(probeImageSizeFromBytes(webpVp8Bytes(320, 240), 'image/webp')).toEqual({
      width: 320,
      height: 240,
    })
    expect(
      probeImageSizeFromBytes(webpVp8xBytes(320, 240).subarray(0, 16), 'image/webp'),
    ).toBeNull()
  })

  test('probeImageSize 读的是同一份文件字节', async () => {
    const file = new File([pngBytes(640, 480)], 'shot.png', { type: 'image/png' })
    expect(await probeImageSize(file, 'image/png')).toEqual({ width: 640, height: 480 })
    expect(await probeImageSize(file, 'image/webp')).toBeNull()
  })
})

describe('startVoiceRecording', () => {
  test('records with the supported mime, releases the mic and returns a typed file', async () => {
    const tracks: string[] = []
    class FakeMediaRecorder {
      static isTypeSupported(mime: string): boolean {
        return mime === 'audio/webm'
      }
      ondataavailable: ((event: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      onerror: (() => void) | null = null
      state = 'inactive'
      start(): void {
        this.state = 'recording'
      }
      stop(): void {
        this.state = 'inactive'
        this.ondataavailable?.({ data: new Blob(['voice']) })
        this.onstop?.()
      }
    }
    globals.MediaRecorder = FakeMediaRecorder
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: async () => ({
          getTracks: () => [
            {
              stop: () => {
                tracks.push('stopped')
              },
            },
          ],
        }),
      },
      configurable: true,
      writable: true,
    })

    const recorder = await startVoiceRecording()
    const recording = await recorder.stop()

    expect(recording.file.type).toBe('audio/webm')
    expect(recording.file.name.endsWith('.webm')).toBe(true)
    expect(recording.durationMs).toBeGreaterThan(0)
    expect(tracks).toEqual(['stopped'])
  })

  test('reports a readable error when the browser has no MediaRecorder', async () => {
    globals.MediaRecorder = undefined
    await expect(startVoiceRecording()).rejects.toThrow('当前浏览器不支持录音')
  })
})

/** 构造最小合法 PNG 头（服务端只校验签名 + IHDR，不看 CRC）。 */
function pngBytes(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(33)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12) // "IHDR"
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

/** 构造 SOI [+ EXIF APP1(Orientation)] + SOF0 + EOI 的最小 JPEG。 */
function jpegBytes(width: number, height: number, orientation?: number): Uint8Array<ArrayBuffer> {
  const parts: number[] = [0xff, 0xd8]
  if (orientation !== undefined) {
    const payload = [
      0x45,
      0x78,
      0x69,
      0x66,
      0x00,
      0x00, // "Exif\0\0"
      0x49,
      0x49,
      0x2a,
      0x00,
      0x08,
      0x00,
      0x00,
      0x00, // TIFF little-endian, IFD0 at 8
      0x01,
      0x00, // 1 entry
      0x12,
      0x01,
      0x03,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      orientation,
      0x00,
      0x00,
      0x00, // 0x0112 SHORT
      0x00,
      0x00,
      0x00,
      0x00, // next IFD
    ]
    const length = payload.length + 2
    parts.push(0xff, 0xe1, (length >> 8) & 0xff, length & 0xff, ...payload)
  }
  parts.push(
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08, // SOF0, length 17, precision 8
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03, // 3 components
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
    0xff,
    0xd9,
  )
  return new Uint8Array(parts)
}

function riff(webpChunk: number[]): Uint8Array<ArrayBuffer> {
  // "WEBP" 之后紧跟一个 chunk，RIFF size = 4 + chunk 总长（含 header）
  const riffSize = 4 + webpChunk.length
  return new Uint8Array([
    0x52,
    0x49,
    0x46,
    0x46, // "RIFF"
    riffSize & 0xff,
    (riffSize >> 8) & 0xff,
    (riffSize >> 16) & 0xff,
    (riffSize >> 24) & 0xff,
    0x57,
    0x45,
    0x42,
    0x50, // "WEBP"
    ...webpChunk,
  ])
}

function webpVp8xBytes(width: number, height: number): Uint8Array<ArrayBuffer> {
  const w = width - 1
  const h = height - 1
  return riff([
    0x56,
    0x50,
    0x38,
    0x58,
    0x0a,
    0x00,
    0x00,
    0x00, // "VP8X", size 10
    0x00,
    0x00,
    0x00,
    0x00, // flags + reserved
    w & 0xff,
    (w >> 8) & 0xff,
    (w >> 16) & 0xff,
    h & 0xff,
    (h >> 8) & 0xff,
    (h >> 16) & 0xff,
  ])
}

function webpVp8lBytes(width: number, height: number): Uint8Array<ArrayBuffer> {
  const w = width - 1
  const h = height - 1
  const b1 = w & 0xff
  const b2 = ((w >> 8) & 0x3f) | ((h & 0x03) << 6)
  const b3 = (h >> 2) & 0xff
  const b4 = (h >> 10) & 0x0f
  return riff([
    0x56,
    0x50,
    0x38,
    0x4c,
    0x05,
    0x00,
    0x00,
    0x00, // "VP8L", size 5
    0x2f,
    b1,
    b2,
    b3,
    b4,
    0x00, // RIFF 块按偶数字节对齐的填充字节（不计入 chunk size）
  ])
}

function webpVp8Bytes(width: number, height: number): Uint8Array<ArrayBuffer> {
  return riff([
    0x56,
    0x50,
    0x38,
    0x20,
    0x0a,
    0x00,
    0x00,
    0x00, // "VP8 ", size 10
    0x00,
    0x00,
    0x00,
    0x9d,
    0x01,
    0x2a, // frame tag + start code
    width & 0xff,
    (width >> 8) & 0xff,
    height & 0xff,
    (height >> 8) & 0xff,
  ])
}
