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

function u32le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]
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
      0,
      0,
      0,
      0, // CRC placeholder
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
      ...u16be(11),
      8, // precision
      ...u16be(1080),
      ...u16be(1920), // height / width
      1, // components
      1,
      0x11,
      0, // one component specification
    ]
    expect(probeImage(bytes(...jpeg), 'image/jpeg')).toEqual({ width: 1920, height: 1080 })
  })

  test('parses WebP VP8X canvas dimensions', () => {
    const chunk = [
      ...'VP8X'.split('').map((c) => c.charCodeAt(0)),
      ...u32le(10), // chunk size
      0x0f,
      0,
      0,
      0, // flags + reserved(3)
      ...[(800 - 1) & 0xff, ((800 - 1) >>> 8) & 0xff, ((800 - 1) >>> 16) & 0xff], // width-1 LE
      ...[(600 - 1) & 0xff, ((600 - 1) >>> 8) & 0xff, ((600 - 1) >>> 16) & 0xff], // height-1 LE
    ]
    const webp = [
      ...'RIFF'.split('').map((c) => c.charCodeAt(0)),
      ...u32le(4 + chunk.length),
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
      ...u32le(packed.length),
      ...packed,
    ]
    const webp = [
      ...'RIFF'.split('').map((c) => c.charCodeAt(0)),
      ...u32le(4 + chunk.length + 1),
      ...'WEBP'.split('').map((c) => c.charCodeAt(0)),
      ...chunk,
      0,
    ]
    expect(probeImage(bytes(...webp), 'image/webp')).toEqual({ width, height })
  })

  test('rejects WebP chunks outside the RIFF-declared boundary', () => {
    const bytesOutsideRiff = bytes(
      0x52,
      0x49,
      0x46,
      0x46,
      0x04,
      0x00,
      0x00,
      0x00,
      0x57,
      0x45,
      0x42,
      0x50,
      0x56,
      0x50,
      0x38,
      0x58,
      0x0a,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
    )
    expect(probeImage(bytesOutsideRiff, 'image/webp')).toBeNull()
  })

  test('rejects a WebP chunk whose odd-byte padding exceeds the RIFF boundary', () => {
    const chunk = [...'VP8L'.split('').map((c) => c.charCodeAt(0)), ...u32le(5), 0x2f, 0, 0, 0, 0]
    const webp = [
      ...'RIFF'.split('').map((c) => c.charCodeAt(0)),
      ...u32le(4 + chunk.length),
      ...'WEBP'.split('').map((c) => c.charCodeAt(0)),
      ...chunk,
    ]
    expect(probeImage(bytes(...webp), 'image/webp')).toBeNull()
  })

  test('rejects truncated image containers instead of zero-filling dimensions', () => {
    expect(probeImage(bytes(0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 1, 0, 1), 'image/jpeg')).toBeNull()
    const truncatedWebp = bytes(
      82,
      73,
      70,
      70,
      0,
      0,
      0,
      0,
      87,
      69,
      66,
      80,
      86,
      80,
      56,
      88,
      0,
      0,
      0,
      10,
      0,
      0,
    )
    expect(probeImage(truncatedWebp, 'image/webp')).toBeNull()
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

/** 组装一个最小 MP4：`ftyp` + `moov{mvhd, trak{mdia{mdhd, minf{stbl{stts}}}}}`。 */
function mp4File(input: {
  timescale: number
  mvhdDuration: number
  /** 省略则只写 mvhd（没有样本表）。 */
  stts?: { count: number; delta: number }[]
}): number[] {
  const mvhdPayload = [
    0,
    0,
    0,
    0, // version + flags
    ...u32be(0),
    ...u32be(0), // creation / modification
    ...u32be(input.timescale),
    ...u32be(input.mvhdDuration),
  ]
  const mvhd = [
    ...u32be(8 + mvhdPayload.length),
    ...'mvhd'.split('').map((c) => c.charCodeAt(0)),
    ...mvhdPayload,
  ]

  const trak = input.stts
    ? (() => {
        const mdhdPayload = [
          0,
          0,
          0,
          0, // version + flags
          ...u32be(0),
          ...u32be(0),
          ...u32be(input.timescale),
          ...u32be(0), // duration（这里不依赖它）
        ]
        const mdhd = [
          ...u32be(8 + mdhdPayload.length),
          ...'mdhd'.split('').map((c) => c.charCodeAt(0)),
          ...mdhdPayload,
        ]
        const entries = input.stts.flatMap((entry) => [
          ...u32be(entry.count),
          ...u32be(entry.delta),
        ])
        const sttsPayload = [0, 0, 0, 0, ...u32be(input.stts.length), ...entries]
        const stts = [
          ...u32be(8 + sttsPayload.length),
          ...'stts'.split('').map((c) => c.charCodeAt(0)),
          ...sttsPayload,
        ]
        const stbl = [
          ...u32be(8 + stts.length),
          ...'stbl'.split('').map((c) => c.charCodeAt(0)),
          ...stts,
        ]
        const minf = [
          ...u32be(8 + stbl.length),
          ...'minf'.split('').map((c) => c.charCodeAt(0)),
          ...stbl,
        ]
        const mdiaPayload = [...mdhd, ...minf]
        const mdia = [
          ...u32be(8 + mdiaPayload.length),
          ...'mdia'.split('').map((c) => c.charCodeAt(0)),
          ...mdiaPayload,
        ]
        return [...u32be(8 + mdia.length), ...'trak'.split('').map((c) => c.charCodeAt(0)), ...mdia]
      })()
    : []

  const moovPayload = [...mvhd, ...trak]
  const moov = [
    ...u32be(8 + moovPayload.length),
    ...'moov'.split('').map((c) => c.charCodeAt(0)),
    ...moovPayload,
  ]
  const ftyp = [
    ...u32be(16),
    ...'ftyp'.split('').map((c) => c.charCodeAt(0)),
    ...Array.from('isom', (c) => c.charCodeAt(0)),
    ...u32be(0),
  ]
  return [...ftyp, ...moov]
}

function box(type: string, ...payload: number[]): number[] {
  return [...u32be(8 + payload.length), ...Array.from(type, (c) => c.charCodeAt(0)), ...payload]
}

function fragmentedMp4(
  options: {
    baseTime?: number
    defaultDuration?: number
    trexDuration?: number
    truncate?: boolean
  } = {},
): Uint8Array {
  const tkhd = box('tkhd', ...u32be(0), ...u32be(0), ...u32be(0), ...u32be(1))
  const mdhd = box('mdhd', ...u32be(0), ...u32be(0), ...u32be(0), ...u32be(1000), ...u32be(0))
  const stts = box('stts', ...u32be(0), ...u32be(0))
  const trak = box(
    'trak',
    ...tkhd,
    ...box('mdia', ...mdhd, ...box('minf', ...box('stbl', ...stts))),
  )
  const trex = box(
    'trex',
    ...u32be(0),
    ...u32be(1),
    ...u32be(1),
    ...u32be(options.trexDuration ?? 0),
    ...u32be(0),
    ...u32be(0),
  )
  const moov = box('moov', ...trak, ...box('mvex', ...trex))
  const tfhd = box(
    'tfhd',
    ...u32be(options.defaultDuration ? 8 : 0),
    ...u32be(1),
    ...(options.defaultDuration ? u32be(options.defaultDuration) : []),
  )
  const tfdt = box('tfdt', ...u32be(0), ...u32be(options.baseTime ?? 0))
  const useDefault = options.defaultDuration || options.trexDuration
  const trun = box(
    'trun',
    ...u32be(useDefault ? 0 : 0x100),
    ...u32be(4),
    ...(useDefault
      ? []
      : Array.from({ length: options.truncate ? 3 : 4 }, () => u32be(880)).flat()),
  )
  return new Uint8Array([
    ...box('ftyp', ...Array.from('isom', (c) => c.charCodeAt(0)), ...u32be(0)),
    ...moov,
    ...box('moof', ...box('traf', ...tfhd, ...tfdt, ...trun)),
  ])
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

  // 回归（评审 blocker 2 的攻面）：不能只信 `Info.Duration`。
  //
  // MediaRecorder 写不写 Duration 都合法，而**篡改**过的文件可以声明一个远小于实际的
  // Duration。服务端唯一的用途是安全上限，所以取「声明值」与「块时间戳下界」的较大者。
  test('never trusts an Info.Duration smaller than what the clusters actually span', () => {
    // Info 声明 1000ms，但 Cluster@32781 + 块偏移 28220 实际到 61001ms。
    const lying = (() => {
      const infoPayload = [
        ...vint(0x2ad7b1, 3),
        ...vint(3),
        ...uintBE(1_000_000, 3),
        ...vint(0x4489, 2),
        ...vint(8),
        ...f64be(1000),
      ]
      const info = [...vint(0x1549a966, 4), ...vint(infoPayload.length), ...infoPayload]
      return webm([info, clusterWithBlocks(32_781, [0, 28_220])], true)
    })()

    expect(probeVoiceDuration(lying, 'audio/webm')).toEqual({ durationMs: 61_001 })
  })

  test('parses MP4 mvhd duration when there is no sample table', () => {
    // 只有 mvhd（没有 trak/stbl）：退化为头部声明值。
    // mvhd：version 0, timescale=44100, duration=44100 → 1000ms
    const file = mp4File({ timescale: 44100, mvhdDuration: 44100 })
    expect(probeVoiceDuration(bytes(...file), 'audio/mp4')).toEqual({ durationMs: 1000 })
  })

  // 回归（评审 F-1）：`mvhd.duration` 只是头部整数，可被篡改。
  // 真实 65s 的 MP4 只要把该字段改成 1s，就能绕过 60s 上限 —— 除非同时读样本表（stts）。
  test('does not trust an MP4 mvhd duration that contradicts the sample table', () => {
    // mvhd 声称 1s，但 stts 里 44100 个样本 × 1024 tick / 44100 = 65.023s。
    const tampered = mp4File({
      timescale: 44100,
      mvhdDuration: 44100, // 谎报 1s
      stts: [
        { count: 2800, delta: 1024 },
        { count: 1, delta: 324 },
      ],
    })
    // 取两者较大者：不能用谎报的 1000ms 放行。
    expect(probeVoiceDuration(bytes(...tampered), 'audio/mp4')).toEqual({ durationMs: 65_023 })

    // 反向：对照组（mvhd 与样本表一致）仍给出样本表的值。
    const honest = mp4File({
      timescale: 44100,
      mvhdDuration: 2_867_524,
      stts: [
        { count: 2800, delta: 1024 },
        { count: 1, delta: 324 },
      ],
    })
    expect(probeVoiceDuration(bytes(...honest), 'audio/mp4')).toEqual({ durationMs: 65_023 })
  })

  test('fails closed for all WebM lacing modes, including BlockGroup with a Duration header', () => {
    for (const flags of [0x82, 0x84, 0x86]) {
      const payload = [0x81, 0, 0, flags, 1, 0, 0]
      for (const block of [
        [...vint(0xa3, 1), ...vint(payload.length), ...payload],
        [
          ...vint(0xa0, 1),
          ...vint(payload.length + 3),
          ...vint(0xa1, 1),
          ...vint(payload.length),
          ...payload,
        ],
      ]) {
        const clusterPayload = [0xe7, 0x82, ...u16be(59_999), ...block]
        const cluster = [...vint(0x1f43b675, 4), ...vint(clusterPayload.length), ...clusterPayload]
        expect(probeVoiceDuration(webm([infoElement(1000), cluster]), 'audio/webm')).toBeNull()
      }
    }
  })

  test('reads fragmented MP4 sample durations and decode times rather than empty moov duration', () => {
    expect(probeVoiceDuration(fragmentedMp4(), 'audio/mp4')).toEqual({ durationMs: 3520 })
    expect(probeVoiceDuration(fragmentedMp4({ baseTime: 59_000 }), 'audio/mp4')).toEqual({
      durationMs: 62_520,
    })
    expect(probeVoiceDuration(fragmentedMp4({ defaultDuration: 880 }), 'audio/mp4')).toEqual({
      durationMs: 3520,
    })
    expect(probeVoiceDuration(fragmentedMp4({ trexDuration: 880 }), 'audio/mp4')).toEqual({
      durationMs: 3520,
    })
    expect(probeVoiceDuration(fragmentedMp4({ truncate: true }), 'audio/mp4')).toBeNull()
  })

  test('parses a real AAC fragmented MP4 with multiple fragments', async () => {
    const file = Bun.file(new URL('./fixtures/voice-fragmented.mp4', import.meta.url))
    expect(probeVoiceDuration(new Uint8Array(await file.arrayBuffer()), 'audio/mp4')).toEqual({
      durationMs: 1021,
    })
  })

  test('includes BlockDuration and rejects unknown-size Clusters', () => {
    const block = [0x81, 0, 0, 0x80, 0]
    const group = [...vint(0xa1, 1), ...vint(block.length), ...block, 0x9b, 0x81, 100]
    const payload = [0xe7, 0x82, ...u16be(59_999), 0xa0, ...vint(group.length), ...group]
    expect(
      probeVoiceDuration(
        webm([[...vint(0x1f43b675, 4), ...vint(payload.length), ...payload]]),
        'audio/webm',
      ),
    ).toEqual({ durationMs: 60_099 })
    expect(
      probeVoiceDuration(
        webm([[...vint(0x1f43b675, 4), 0xff, 0xe7, 0x81, 1], clusterWithBlocks(65_000, [0])], true),
        'audio/webm',
      ),
    ).toBeNull()
  })

  test('rejects MP4 without a supported ftyp and truncated version-1 mvhd', () => {
    const valid = mp4File({ timescale: 1000, mvhdDuration: 1000 })
    expect(probeVoiceDuration(new Uint8Array(valid.slice(16)), 'audio/mp4')).toBeNull()
    const unsupported = [...valid]
    unsupported.splice(8, 4, ...Array.from('xxxx', (c) => c.charCodeAt(0)))
    expect(probeVoiceDuration(new Uint8Array(unsupported), 'audio/mp4')).toBeNull()
    const truncated = [
      ...valid.slice(0, 16),
      ...box(
        'moov',
        ...box(
          'mvhd',
          1,
          0,
          0,
          0,
          ...u32be(0),
          ...u32be(0),
          ...u32be(0),
          ...u32be(0),
          ...u32be(1000),
        ),
      ),
    ]
    expect(probeVoiceDuration(new Uint8Array(truncated), 'audio/mp4')).toBeNull()
  })

  test('fails closed on oversized WebM uint fields and truncated MP4 sample tables', () => {
    const oversizedTimecode = clusterElement(1)
    oversizedTimecode.splice(6, 1, 0x89)
    oversizedTimecode.splice(7, 1, 1)
    oversizedTimecode.splice(8, 0, 0, 0, 0, 0, 0, 0, 0)
    expect(probeVoiceDuration(webm([oversizedTimecode], true), 'audio/webm')).toBeNull()

    const valid = mp4File({
      timescale: 1000,
      mvhdDuration: 1000,
      stts: [{ count: 1, delta: 1000 }],
    })
    const sttsType = [115, 116, 116, 115]
    const sttsTypeOffset = valid.findIndex((_, index) =>
      sttsType.every((value, offset) => valid[index + offset] === value),
    )
    expect(sttsTypeOffset).toBeGreaterThan(0)
    if (sttsTypeOffset > 0) {
      // Replace stts entry_count=1 with 2 without adding the second entry.
      valid[sttsTypeOffset + 8 + 3] = 2
    }
    expect(probeVoiceDuration(new Uint8Array(valid), 'audio/mp4')).toBeNull()
  })

  test('rejects truncated WebM Segments and truncated nested MP4 boxes', () => {
    const webmBytes = [...webm([infoElement(1000)])]
    // Segment size is the one-byte VINT at offset 9; claim 127 bytes while the object is shorter.
    webmBytes.splice(9, 1, 0x40, 0x7f)
    expect(probeVoiceDuration(new Uint8Array(webmBytes), 'audio/webm')).toBeNull()

    const mp4 = mp4File({ timescale: 1000, mvhdDuration: 1000, stts: [{ count: 1, delta: 1000 }] })
    const moovSize = new DataView(new Uint8Array(mp4).buffer).getUint32(16, false)
    const malformedFree = [0, 0, 0, 16, ...Array.from('free', (c) => c.charCodeAt(0)), 0, 0, 0, 0]
    const expanded = [...mp4]
    expanded[16] = ((moovSize + malformedFree.length) >>> 24) & 0xff
    expanded[17] = ((moovSize + malformedFree.length) >>> 16) & 0xff
    expanded[18] = ((moovSize + malformedFree.length) >>> 8) & 0xff
    expanded[19] = (moovSize + malformedFree.length) & 0xff
    expanded.push(...malformedFree)
    expect(probeVoiceDuration(new Uint8Array(expanded), 'audio/mp4')).toBeNull()
  })

  test('rejects an oversized TimecodeScale even when a cluster could provide a duration', () => {
    const oversizedScale = [...vint(0x2ad7b1, 3), ...vint(9), 1, 0, 0, 0, 0, 0, 0, 0, 1]
    const info = [...vint(0x1549a966, 4), ...vint(oversizedScale.length), ...oversizedScale]
    expect(probeVoiceDuration(webm([info, clusterElement(1000)], true), 'audio/webm')).toBeNull()
  })

  test('rejects truncated WebM element headers after valid duration data', () => {
    const infoThenTruncatedElement = bytes(
      0x1a,
      0x45,
      0xdf,
      0xa3,
      0x80,
      0x18,
      0x53,
      0x80,
      0x67,
      0xff,
      0x15,
      0x49,
      0xa9,
      0x66,
      0x88,
      0x44,
      0x89,
      0x84,
      0x44,
      0x7a,
      0x00,
      0x00,
      0xe7,
    )
    const clusterThenTruncatedId = bytes(
      0x1a,
      0x45,
      0xdf,
      0xa3,
      0x80,
      0x18,
      0x53,
      0x80,
      0x67,
      0xff,
      0x1f,
      0x43,
      0xb6,
      0x75,
      0x85,
      0xe7,
      0x82,
      0x03,
      0xe8,
      0x40,
    )
    expect(probeVoiceDuration(infoThenTruncatedElement, 'audio/webm')).toBeNull()
    expect(probeVoiceDuration(clusterThenTruncatedId, 'audio/webm')).toBeNull()
  })

  test('rejects malformed MP4 sample tables even when mdhd cannot provide duration', () => {
    const mvhd = box('mvhd', 0, 0, 0, 0, ...u32be(0), ...u32be(0), ...u32be(1000), ...u32be(1000))
    const mdhd = box('mdhd', 0, 0, 0, 0, ...u32be(0), ...u32be(0), ...u32be(0), ...u32be(0))
    const truncatedStts = box('stts', 0, 0, 0, 0, ...u32be(1))
    const stbl = box('stbl', ...truncatedStts)
    const minf = box('minf', ...stbl)
    const mdia = box('mdia', ...mdhd, ...minf)
    const track = box('trak', ...mdia)
    const file = [
      ...mp4File({ timescale: 1000, mvhdDuration: 1000 }).slice(0, 16),
      ...box('moov', ...mvhd, ...track),
    ]
    expect(probeVoiceDuration(new Uint8Array(file), 'audio/mp4')).toBeNull()
  })

  test('rejects duplicate or invalid Blocks in one BlockGroup', () => {
    const duplicateBlocks = bytes(
      0x1a,
      0x45,
      0xdf,
      0xa3,
      0x80,
      0x18,
      0x53,
      0x80,
      0x67,
      0xff,
      0x1f,
      0x43,
      0xb6,
      0x75,
      0x94,
      0xe7,
      0x82,
      0x7d,
      0x00,
      0xa0,
      0x8e,
      0xa1,
      0x85,
      0x81,
      0x75,
      0x30,
      0x80,
      0x00,
      0xa1,
      0x85,
      0x81,
      0x00,
      0x00,
      0x80,
      0x00,
    )
    expect(probeVoiceDuration(duplicateBlocks, 'audio/webm')).toBeNull()

    const invalidThenValid = new Uint8Array(duplicateBlocks)
    invalidThenValid[26] = 0x82
    expect(probeVoiceDuration(invalidThenValid, 'audio/webm')).toBeNull()
  })

  test('rejects duplicate MP4 stts boxes instead of checking only the last one', () => {
    const makeFile = (firstStts: number[]) => {
      const mvhd = box('mvhd', 0, 0, 0, 0, ...u32be(0), ...u32be(0), ...u32be(1000), ...u32be(1000))
      const mdhd = box('mdhd', 0, 0, 0, 0, ...u32be(0), ...u32be(0), ...u32be(1000), ...u32be(0))
      const validStts = box('stts', 0, 0, 0, 0, ...u32be(1), ...u32be(1), ...u32be(1000))
      const stbl = box('stbl', ...firstStts, ...validStts)
      const track = box('trak', ...box('mdia', ...mdhd, ...box('minf', ...stbl)))
      return [
        ...mp4File({ timescale: 1000, mvhdDuration: 1000 }).slice(0, 16),
        ...box('moov', ...mvhd, ...track),
      ]
    }

    const longFirst = box('stts', 0, 0, 0, 0, ...u32be(1), ...u32be(1), ...u32be(65_000))
    expect(probeVoiceDuration(new Uint8Array(makeFile(longFirst)), 'audio/mp4')).toBeNull()

    const truncatedFirst = box('stts', 0, 0, 0, 0, ...u32be(1))
    expect(probeVoiceDuration(new Uint8Array(makeFile(truncatedFirst)), 'audio/mp4')).toBeNull()
  })

  test('returns null for unsupported mime or malformed payload', () => {
    expect(probeVoiceDuration(bytes(1, 2, 3), 'audio/mpeg')).toBeNull()
    expect(probeVoiceDuration(new Uint8Array(0), 'audio/webm')).toBeNull()
    expect(probeVoiceDuration(bytes(1, 2, 3), 'audio/mp4')).toBeNull()
  })
})
