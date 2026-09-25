import { describe, expect, test } from 'bun:test'
import {
  imageRejectReason,
  MEDIA_IMAGE_MAX_BYTES,
  MEDIA_IMAGE_PICK_LIMIT,
  mediaObjectUrl,
  voiceDurationLabel,
  voiceMimeFromBytes,
} from '../src/features/chat/media'

/**
 * 会话媒体纯逻辑（#67 第四步）。
 *
 * 这里锁的是三件曾经只能靠人眼在真机上碰运气的事：
 * 1. **语音容器判定**：契约只收 `audio/webm` / `audio/mp4`，而微信录音机只产出
 *    mp3 / aac / wav / PCM。判不出容器就不能发（`uploadChatVoice` 会直接报
 *    「当前录音格式暂不支持发送语音」），所以几个真实字节头必须逐个钉死。
 * 2. **单张 5MB 的本地预检**：边界值不能差一个字节（服务端 `stat.size` 是硬比对）。
 * 3. **下载地址**：验收⑤要求私有媒体不能拼成公开对象存储地址，拼接处不能多一个斜杠。
 */

const bytesOf = (values: number[]): ArrayBuffer => new Uint8Array(values).buffer

/** MP4/M4A 的容器特征：第 4..8 字节是 `ftyp` 盒子类型 */
const mp4Head = (): ArrayBuffer =>
  bytesOf([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0])

/** WebM(EBML) 的四个魔数字节 */
const webmHead = (): ArrayBuffer =>
  bytesOf([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f])

describe('voiceMimeFromBytes —— 按字节头认语音容器', () => {
  test('ftyp 盒子 → audio/mp4（m4a / 断片 mp4 都是这个头）', () => {
    expect(voiceMimeFromBytes(mp4Head())).toBe('audio/mp4')
  })

  test('EBML 魔数 → audio/webm', () => {
    expect(voiceMimeFromBytes(webmHead())).toBe('audio/webm')
  })

  test('认不出来就返回 null，不猜（宁可不发也不发一条服务端必然 422 的语音）', () => {
    // ADTS 头（微信 `format: 'aac'` 在部分基础库上产出这个）—— 契约白名单里没有它
    expect(voiceMimeFromBytes(bytesOf([0xff, 0xf1, 0x50, 0x80, 0x00, 0x1f, 0xfc]))).toBeNull()
    // mp3（`ID3` 标签头）
    expect(voiceMimeFromBytes(bytesOf([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00]))).toBeNull()
    // WAV（`RIFF`）
    expect(voiceMimeFromBytes(bytesOf([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00]))).toBeNull()
  })

  test('空文件 / 不足 12 字节 / 全是 0 都返回 null', () => {
    expect(voiceMimeFromBytes(bytesOf([]))).toBeNull()
    expect(voiceMimeFromBytes(bytesOf([0, 0, 0, 24]))).toBeNull()
    expect(voiceMimeFromBytes(bytesOf([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull()
  })

  test('`ftyp` 出现在别的偏移不算 MP4（只看第 4..8 字节）', () => {
    // 0..4 就是 ftyp：这是「文件开头就是盒子类型」的畸形数据，不是 MP4
    expect(
      voiceMimeFromBytes(bytesOf([0x66, 0x74, 0x79, 0x70, 0, 0, 0, 24, 0, 0, 0, 0])),
    ).toBeNull()
  })
})

describe('imageRejectReason —— 单张 5MB 的本地预检', () => {
  test('刚好 5MB 通过', () => {
    expect(imageRejectReason(MEDIA_IMAGE_MAX_BYTES)).toBeNull()
  })

  test('超过一个字节就拦下来，文案与契约上限一致', () => {
    expect(imageRejectReason(MEDIA_IMAGE_MAX_BYTES + 1)).toBe('单张图片不能超过 5MB')
  })

  test('0 字节不归这里管（空文件由读取与 mime 判定负责）', () => {
    expect(imageRejectReason(0)).toBeNull()
  })
})

describe('voiceDurationLabel —— 语音气泡时长', () => {
  test('不足 1 秒显示 1″，不显示 0″（短按是常见操作，0″ 看起来像坏了）', () => {
    expect(voiceDurationLabel(0)).toBe('1″')
    expect(voiceDurationLabel(320)).toBe('1″')
    expect(voiceDurationLabel(1000)).toBe('1″')
  })

  test('往上取整：1001ms 算 2″（宁可多报也不能少报）', () => {
    expect(voiceDurationLabel(1001)).toBe('2″')
    expect(voiceDurationLabel(59_999)).toBe('60″')
  })

  test('契约允许 null（图片媒体）与 undefined：都退到 1″，不显示 NaN', () => {
    expect(voiceDurationLabel(null)).toBe('1″')
    expect(voiceDurationLabel(undefined)).toBe('1″')
    expect(voiceDurationLabel(-5)).toBe('1″')
  })

  test('契约上限 60 秒显示 60″', () => {
    expect(voiceDurationLabel(60_000)).toBe('60″')
  })
})

describe('mediaObjectUrl —— 私有媒体的鉴权下载地址', () => {
  const conversationId = '01930000-0000-7000-8000-000000000041'
  const mediaId = '01930000-0000-7000-8000-0000000000a1'

  test('拼在 API 基址上（不是对象存储域名），路径走契约的 mediaObject', () => {
    expect(mediaObjectUrl('http://localhost:3001', conversationId, mediaId)).toBe(
      `http://localhost:3001/conversations/${conversationId}/media/${mediaId}`,
    )
  })

  test('基址带结尾斜杠不会拼出双斜杠（presign 与下载必须命中同一路径）', () => {
    expect(mediaObjectUrl('http://localhost:3001/', conversationId, mediaId)).toBe(
      `http://localhost:3001/conversations/${conversationId}/media/${mediaId}`,
    )
    expect(mediaObjectUrl('http://localhost:3001///', conversationId, mediaId)).toBe(
      `http://localhost:3001/conversations/${conversationId}/media/${mediaId}`,
    )
  })
})

describe('常量 —— 与契约口径对齐', () => {
  test('单次最多挑 9 张（微信 chooseMedia 的上限）', () => {
    expect(MEDIA_IMAGE_PICK_LIMIT).toBe(9)
  })

  test('5MB 上限来自契约的 MEDIA_MAX_IMAGE_BYTES', () => {
    expect(MEDIA_IMAGE_MAX_BYTES).toBe(5 * 1024 * 1024)
  })
})
