import { describe, expect, test } from 'bun:test'
import { probeImage, probeVoiceDuration } from './media-probe'

// 构造字节的小工具
function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values)
}

/** EBML **元素 ID / size** 的 VINT 编码（marker = 1 << (8 - length)）。 */
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

/**
 * EBML **Unsigned Integer Element Data**：普通 big-endian，**不是 VINT**。
 *
 * 这是评审 blocker 2 的关键：测试样本过去用 `vint()` 编码 Timecode / TimecodeScale，
 * 于是把实现的错误一起冻结了。真实 muxer（MediaRecorder、ffmpeg）写的是普通大端整数。
 */
function uintBE(value: number, length: number): number[] {
  const out: number[] = []
  for (let i = length - 1; i >= 0; i--) out.push((value >>> (8 * i)) & 0xff)
  return out
}

/** 按真实 muxer 习惯选最小字节数（但至少 1 字节）。 */
function uintBEmin(value: number): number[] {
  const length = value < 0x100 ? 1 : value < 0x10000 ? 2 : value < 0x1000000 ? 3 : 4
  return uintBE(value, length)
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

const EBML_HEADER = [0x1a, 0x45, 0xdf, 0xa3, ...vint(0)]
const SEGMENT_ID = [0x18, 0x53, 0x80, 0x67]

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

// ---- WebM 样本构造（贴近真实 muxer 的编码）----

/** `Info[TimecodeScale, Duration]`；Duration 缺省时省略该字段。 */
function infoElement(durationMs: number | null, timecodeScale = 1_000_000): number[] {
  // TimecodeScale 是 uint（普通大端），Duration 是 EBML Float64（单位 = scale 的 tick 数）。
  const scaleBytes = uintBEmin(timecodeScale)
  const timecodeScaleField = [...vint(0x2ad7b1, 3), ...vint(scaleBytes.length), ...scaleBytes]
  const durationField =
    durationMs === null ? [] : [...vint(0x4489, 2), ...vint(8), ...f64be(durationMs)]
  const payload = [...timecodeScaleField, ...durationField]
  return [...vint(0x1549a966, 4), ...vint(payload.length), ...payload]
}

/** `Cluster[Timecode, ...payload]`；Timecode 用普通大端 uint 编码（真实 muxer 的行为）。 */
function clusterElement(timecode: number, filler = 0): number[] {
  const timecodeField = [
    ...vint(0xe7, 1),
    ...vint(uintBEmin(timecode).length),
    ...uintBEmin(timecode),
  ]
  // 真实 Cluster 里 Timecode 之后还有其他子元素；加一段哑字节让"最后一个 Cluster"断言有意义。
  const fillerField =
    filler > 0 ? [...vint(0xa3, 1), ...vint(filler), ...new Array(filler).fill(0)] : []
  const payload = [...timecodeField, ...fillerField]
  return [...vint(0x1f43b675, 4), ...vint(payload.length), ...payload]
}

/** 一个 `SimpleBlock`：TrackNumber(vint=1) + 相对时间戳(int16 BE) + flags + 1 字节数据。 */
function simpleBlock(relativeOffset: number): number[] {
  const payload = [
    0x81, // TrackNumber = 1
    (relativeOffset >> 8) & 0xff,
    relativeOffset & 0xff,
    0x80, // flags（keyframe）
    0x00, // 1 字节 frame data（本例不真正解码）
  ]
  return [...vint(0xa3, 1), ...vint(payload.length), ...payload]
}

/**
 * 一个 Cluster：`Timecode` + 若干 `SimpleBlock` 及其**相对**偏移。
 *
 * 这是评审发现的真实形状：Cluster 的 Timecode 只是该 Cluster 的**起始**时刻，
 * 真正的时长要看最后一个块的时间戳（`timecode + max(相对偏移)`）。
 */
function clusterWithBlocks(timecode: number, relativeOffsets: number[]): number[] {
  const timecodeField = [
    ...vint(0xe7, 1),
    ...vint(uintBEmin(timecode).length),
    ...uintBEmin(timecode),
  ]
  const blocks = relativeOffsets.flatMap(simpleBlock)
  const payload = [...timecodeField, ...blocks]
  return [...vint(0x1f43b675, 4), ...vint(payload.length), ...payload]
}

/** 组装 Segment；`unknownSize` 模拟 MediaRecorder 流式 WebM。
 *
 * 真实文件（ffmpeg/MediaRecorder `-live`）的未知长度标记是 **8 字节 VINT 全值位**：
 * `01 FF FF FF FF FF FF FF`（首字节是标记位 0x01，不是 0xFF）。
 */
function webm(chunks: number[][], unknownSize = false): Uint8Array {
  const segmentPayload = chunks.flat()
  const segmentSize = unknownSize
    ? [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
    : vint(segmentPayload.length)
  return new Uint8Array([...EBML_HEADER, ...SEGMENT_ID, ...segmentSize, ...segmentPayload])
}

describe('probeVoiceDuration', () => {
  test('parses WebM Duration from EBML Info', () => {
    // Info[TimecodeScale=1ms, Duration=3500 tick] → 3500ms
    expect(probeVoiceDuration(webm([infoElement(3500)]), 'audio/webm')).toEqual({
      durationMs: 3500,
    })
  })

  test('reads TimecodeScale as an unsigned integer, not a VINT', () => {
    // Duration 的单位是 scale 的 tick 数：`durationMs = ticks * scale / 1e6`。
    // 默认 scale=1_000_000（1 tick = 1ms）时 2000 tick = 2000ms。
    expect(probeVoiceDuration(webm([infoElement(2000)]), 'audio/webm')).toEqual({
      durationMs: 2000,
    })
    // scale=1e9（1 tick = 1000ms）时 2 tick = 2000ms。
    // 1e9 = `0x3B9ACA00`（4 字节 uint）：当 VINT 解会剥掉首字节的标记位（0x10）
    // 变成 `0x0B9ACA00` = 194_699_776 → 389ms，与真实的 2000ms 差 5 倍。
    expect(probeVoiceDuration(webm([infoElement(2, 1_000_000_000)]), 'audio/webm')).toEqual({
      durationMs: 2000,
    })
  })

  // 回归（评审 blocker 2）：Timecode 是 uint。使用高字节置位的值（如 89981 = 0x015F7D）时，
  // 旧的 VINT 解码会剥掉首字节最高位得到 46461，让 59s 录音看起来只有 9.8s 从而绕过 60s 上限。
  test('decodes Cluster Timecode as an unsigned integer even when the top bit is set', () => {
    // 89981 是 3 字节 uint，首字节 0x01 —— 走 VINT 会得到 46461。
    expect(probeVoiceDuration(webm([clusterElement(89_981)]), 'audio/webm')).toEqual({
      durationMs: 89_981,
    })
    // 2 字节 uint 里首字节最高位置位的值（16981 = 0x4255）：VINT 解会得到 597。
    expect(probeVoiceDuration(webm([clusterElement(16_981)]), 'audio/webm')).toEqual({
      durationMs: 16_981,
    })
  })

  test('falls back to the last Cluster Timecode when Duration is absent', () => {
    // 流式 MediaRecorder 的典型形状：无 Duration，多个 Cluster。
    // 必须是**最后一个** Cluster 的 Timecode（4800），而不是第一个（1000）。
    expect(
      probeVoiceDuration(
        webm([infoElement(null), clusterElement(1000), clusterElement(4800)], true),
        'audio/webm',
      ),
    ).toEqual({ durationMs: 4800 })
  })

  test('takes the largest cluster end timecode, never under-reporting on out-of-order files', () => {
    // 时间码单调递增是 muxer 的保证，但这是一个**安全上限**：遇到坏文件宁可高估、不可低估，
    // 否则超长录音就能靠乱序 timecode 混过 60s 校验。所以取所有 Cluster 结束时刻的最大值。
    expect(
      probeVoiceDuration(webm([clusterElement(30_000), clusterElement(5000)], true), 'audio/webm'),
    ).toEqual({ durationMs: 30_000 })
  })

  // 回归：未知长度的 Segment（全 1 size）与 size = 0 的空元素都不能让遍历原地自旋。
  test('terminates on empty elements and unknown-size segments', () => {
    // 一个 size = 0 的 Void 元素（id 0xEC）夹在 Cluster 之间：旧实现 `continue` 不推进游标。
    const emptyVoid = [...vint(0xec, 1), ...vint(0)]
    expect(
      probeVoiceDuration(
        webm([clusterElement(1200), emptyVoid, clusterElement(5900)], true),
        'audio/webm',
      ),
    ).toEqual({ durationMs: 5900 })
  })

  // 回归（评审 blocker 2 的第二半）：Cluster 的 Timecode 只是起点，必须加上块的相对偏移。
  //
  // 真实单 Cluster 文件（ffmpeg `-cluster_time_limit 1000000`）实测：61s 只被算成 32.8s、
  // 130s 只被算成 98.3s —— 前者正好绕过 60s 上限。只断言"最后一个 Cluster 的 Timecode"
  // 的用例抓不到它，所以这里显式构造带块偏移的样本。
  test('adds the block relative offset to the last cluster timecode', () => {
    // Cluster @ 32781ms，块偏移最大 +28220 ⇒ 结束在 61001ms（> 60s，必须被拒）。
    expect(
      probeVoiceDuration(webm([clusterWithBlocks(32_781, [0, -100, 28_220])], true), 'audio/webm'),
    ).toEqual({ durationMs: 61_001 })

    // 反向保证：没有块偏移时退化为 Cluster Timecode（不因缺块而变 null）。
    expect(probeVoiceDuration(webm([clusterElement(4800)], true), 'audio/webm')).toEqual({
      durationMs: 4800,
    })

    // 负偏移（B 帧早于 Cluster Timecode）不能让结果倒退。
    expect(
      probeVoiceDuration(webm([clusterWithBlocks(5000, [-2000])], true), 'audio/webm'),
    ).toEqual({ durationMs: 5000 })
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
