import { afterEach, describe, expect, test } from 'bun:test'
import {
  describeImageDimensionRejection,
  describeMediaFileRejection,
  describeVoiceDurationRejection,
  formatVoiceDuration,
  pickVoiceRecorderMime,
  probeImageSize,
  startVoiceRecording,
  VOICE_RECORDER_MIME_CANDIDATES,
} from './media'

function file(type: string, size: number): Pick<File, 'type' | 'size'> {
  return { type, size }
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

describe('probeImageSize', () => {
  test('reads the decoded bitmap size and always closes it', async () => {
    let closed = false
    globals.createImageBitmap = async () => ({
      width: 800,
      height: 600,
      close: () => {
        closed = true
      },
    })

    expect(await probeImageSize(new File(['x'], 'a.png', { type: 'image/png' }))).toEqual({
      width: 800,
      height: 600,
    })
    expect(closed).toBe(true)
  })

  test('returns null when the browser cannot decode the file', async () => {
    globals.createImageBitmap = async () => {
      throw new Error('decode failed')
    }
    expect(await probeImageSize(new File(['x'], 'a.png', { type: 'image/png' }))).toBeNull()
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
