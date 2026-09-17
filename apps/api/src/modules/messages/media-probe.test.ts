import { describe, expect, test } from 'bun:test'
import { probeImage, probeVoiceDuration } from './media-probe'

// 构造字节的小工具
function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values)
}

/** WebM/EBML vint 编码（受 parser 使用的同一种：marker = 1 << (8 - length)）。 */
function vint(value: number, length: 1 | 2 | 3 | 4 = 2): number[] {
  const result: number[] = []
  let remaining = value
  for (let i = length - 1; i >= 1; i--) {
    result.unshift(remaining & 0xff)
    remaining >>>= 8
  }
  const valueBits = 8 * length - length // 7/14/21/28
  const mask = (1 << valueBits) - 1
  result.unshift(((remaining & mask) | ((1 << (8 - length)) as number)) & 0xff)
  return result
}

/** 把大数写为 8 字节大端 double。 */
function f64be(value: number): number[] {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value, false)
  const out: number[] = []
  for (let i = 0; i < 8; i++) out.push(view.getUint8(i))
  return out
}

function u32be(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
}

function u16be(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff]
}

describe('probeImage', () => {
  test('parses a minimal PNG width/height', () => {
    const png = [
      137,
      80,
      78,
      71,
      13,
      10,
      26,
      10, // signature
      ...u32be(13), // IHDR chunk length
      ...'IHDR'.split('').map((c) => c.charCodeAt(0)),
      ...u32be(320),
      ...u32be(240), // width / height
      8,
      6,
      0,
      0,
      0, // bit depth / color type / compression / filter / interlace
    ]
    expect(probeImage(bytes(...png), 'image/png')).toEqual({ width: 320, height: 240 })
  })

  test('parses a JPEG SOF marker', () => {
    // SOI(FF D8) + SOF2(FF C2)：length(2) + 精度(1) + height(2) + width(2) + 组件数(1)
    const jpeg = [
      0xff,
      0xd8, // SOI
      0xff,
      0xc2,
      ...u16be(10),
      8, // SOF2：段长 10（含长度字段）、precision=8
      ...u16be(1080),
      ...u16be(1920), // height / width
      3, // components
    ]
    expect(probeImage(bytes(...jpeg), 'image/jpeg')).toEqual({ width: 1920, height: 1080 })
  })

  test('parses WebP VP8X canvas dimensions', () => {
    const chunk = [
      ...'VP8X'.split('').map((c) => c.charCodeAt(0)),
      ...u32be(10), // chunk size
      0x0f,
      0,
      0,
      0, // flags + reserved(3)
      ...[(800 - 1) & 0xff, ((800 - 1) >>> 8) & 0xff, ((800 - 1) >>> 16) & 0xff], // width-1 LE
      ...[(600 - 1) & 0xff, ((600 - 1) >>> 8) & 0xff, ((600 - 1) >>> 16) & 0xff], // height-1 LE
    ]
    const webp = [
      ...'RIFF'.split('').map((c) => c.charCodeAt(0)),
      ...u32be(8 + chunk.length),
      ...'WEBP'.split('').map((c) => c.charCodeAt(0)),
      ...chunk,
    ]
    expect(probeImage(bytes(...webp), 'image/webp')).toEqual({ width: 800, height: 600 })
  })

  test('parses WebP VP8L packed dimensions', () => {
    const width = 1234
    const height = 57
    const wh = (width - 1) | ((height - 1) << 14)
    const packed = [0x2f, wh & 0xff, (wh >>> 8) & 0xff, (wh >>> 16) & 0xff, (wh >>> 24) & 0xff]
    const chunk = [
      ...'VP8L'.split('').map((c) => c.charCodeAt(0)),
      ...u32be(packed.length),
      ...packed,
    ]
    const webp = [
      ...'RIFF'.split('').map((c) => c.charCodeAt(0)),
      ...u32be(8 + chunk.length),
      ...'WEBP'.split('').map((c) => c.charCodeAt(0)),
      ...chunk,
    ]
    expect(probeImage(bytes(...webp), 'image/webp')).toEqual({ width, height })
  })

  test('rejects a non-image / truncated input as null', () => {
    expect(probeImage(bytes(1, 2, 3, 4), 'image/png')).toBeNull()
    expect(probeImage(new Uint8Array(0), 'image/jpeg')).toBeNull()
    expect(probeImage(bytes(1, 2, 3), 'image/webp')).toBeNull()
  })
})

describe('probeVoiceDuration', () => {
  test('parses WebM Duration from EBML Info', () => {
    // 构造：EBML Header + Segment(Info[TimecodeScale=1000000, Duration=3500])
    // Matroska Duration 单位 = TimestampScale(1ms)，3500 tick = 3500ms。
    // 注意：EBML 元素 ID 是 raw 字节，size 字段 = 数据字节数(vint)，值本身用 vint 编码。
    const timecodeScale = [...vint(0x2ad7b1, 3), ...vint(3), ...vint(1_000_000, 3)]
    const duration = [...vint(0x4489, 2), ...vint(8), ...f64be(3500)]
    const infoPayload = [...timecodeScale, ...duration]
    const info = [...vint(0x1549a966, 4), ...vint(infoPayload.length), ...infoPayload]
    const ebmlHeader = [0x1a, 0x45, 0xdf, 0xa3, ...vint(0)]
    const segmentId = [0x18, 0x53, 0x80, 0x67]
    const file = [...ebmlHeader, ...segmentId, ...vint(ebmlHeader.length + info.length), ...info]
    expect(probeVoiceDuration(bytes(...file), 'audio/webm')).toEqual({ durationMs: 3500 })
  })

  test('falls back to the last Cluster Timecode when Duration is absent', () => {
    // Segment 只有 Cluster[Timecode=4800]，无 Info.Duration → 4800 * 1ms = 4800ms
    const clusterPayload = [...vint(0xe7, 1), ...vint(2), ...vint(4800, 2)]
    const cluster = [...vint(0x1f43b675, 4), ...vint(clusterPayload.length), ...clusterPayload]
    const ebmlHeader = [0x1a, 0x45, 0xdf, 0xa3, ...vint(0)]
    const file = [...ebmlHeader, ...[0x18, 0x53, 0x80, 0x67], ...vint(cluster.length), ...cluster]
    expect(probeVoiceDuration(bytes(...file), 'audio/webm')).toEqual({ durationMs: 4800 })
  })

  test('parses MP4 mvhd duration', () => {
    // mvhd：version 0, timescale=44100, duration=44100 → 1000ms
    const mvhdPayload = [
      0,
      0,
      0,
      0, // version + flags
      ...u32be(0),
      ...u32be(0), // creation/modification time
      ...u32be(44100), // timescale
      ...u32be(44100), // duration
    ]
    const mvhd = [
      ...u32be(8 + mvhdPayload.length),
      ...'mvhd'.split('').map((c) => c.charCodeAt(0)),
      ...mvhdPayload,
    ]
    const moov = [
      ...u32be(8 + mvhd.length),
      ...'moov'.split('').map((c) => c.charCodeAt(0)),
      ...mvhd,
    ]
    const ftyp = [
      ...u32be(16),
      ...'ftyp'.split('').map((c) => c.charCodeAt(0)),
      ...u32be(0),
      ...u32be(0),
    ]
    const file = [...ftyp, ...moov]
    expect(probeVoiceDuration(bytes(...file), 'audio/mp4')).toEqual({ durationMs: 1000 })
  })

  test('returns null for unsupported mime or malformed payload', () => {
    expect(probeVoiceDuration(bytes(1, 2, 3), 'audio/mpeg')).toBeNull()
    expect(probeVoiceDuration(new Uint8Array(0), 'audio/webm')).toBeNull()
    expect(probeVoiceDuration(bytes(1, 2, 3), 'audio/mp4')).toBeNull()
  })
})
