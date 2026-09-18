/**
 * 媒体真实尺寸 / 真实时长的服务端解析（fix-plan F5 / Q3=B1）。
 *
 * 只读容器结构，不解码媒体数据，零第三方依赖：
 * - 图片尺寸：PNG(IHDR) / JPEG(SOFn) / WebP(VP8/VP8L/VP8X)
 * - 语音时长：WebM(EBML Segment→Info→Duration，缺失时用最后 Cluster 的 Timecode) / MP4(mvhd)
 *
 * 所有解析失败均返回 null，由调用方 fail-closed（拒绝上传），
 * 不信任客户端声明的 width/height/durationMs。
 *
 * 关键约定（评审 blocker 2）：EBML 的 `TimecodeScale` / `Timecode` 是 **Unsigned Integer
 * Element Data**（普通大端整数），不是 VINT。把它们当 VINT 去标记位会在时间码高字节置位时
 * 算出远小于真实值的数（实测 MediaRecorder `-live` 的 59s 文件被解析成 9.8s），
 * 从而绕过 60s 上限。VINT 只用于元素 ID 与元素 size。
 */

export type ProbedImage = { width: number; height: number }
export type ProbedDuration = { durationMs: number }

/** 读取 Uint8Array 中的 32-bit 大端无符号整数。 */
function u32be(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0)
  )
}

function u16be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0)
}

function u16le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)
}

function u24le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16)
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] ?? 0)
  return out
}

// ---------------------------------------------------------------------------
// 图片尺寸
// ---------------------------------------------------------------------------

/**
 * PNG：固定 8 字节签名 + IHDR chunk（length(4) + "IHDR" + width(4) + height(4)）。
 */
function pngSize(bytes: Uint8Array): ProbedImage | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) return null
  }
  if (ascii(bytes, 12, 4) !== 'IHDR') return null
  const width = u32be(bytes, 16)
  const height = u32be(bytes, 20)
  if (width === 0 || height === 0) return null
  return { width, height }
}

/**
 * JPEG：扫描 marker 到 SOFn（C0/C1/C2/…，排除 C4/C8/CC），
 * SOF 结构：length(2) + precision(1) + height(2) + width(2)。
 */
function jpegSize(bytes: Uint8Array): ProbedImage | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null
    const marker = bytes[offset + 1] ?? 0
    // SOFn：C0-CF 去掉 C4(DHT)、C8(JPG)、CC(DAC)
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      const height = u16be(bytes, offset + 5)
      const width = u16be(bytes, offset + 7)
      if (width === 0 || height === 0) return null
      return { width, height }
    }
    // 0xD8/0xD9（SOI/EOI）没有长度段
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2
      continue
    }
    // 其余 marker 都有 2 字节长度（含自身）
    const segmentLength = u16be(bytes, offset + 2)
    offset += 2 + segmentLength
  }
  return null
}

/**
 * WebP：RIFF/WEBP 头后再按 chunk 分派：
 * - VP8 : 3 字节 frame tag + start code + width(2 LE) + height(2 LE)
 * - VP8L: 1 字节签名(0x2f) + 14-bit width/height（少 1 的位打包）
 * - VP8X: 10 字节头，4..9 是 24-bit LE 的 canvas width/height（少 1）
 */
function webpSize(bytes: Uint8Array): ProbedImage | null {
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return null
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const fourCc = ascii(bytes, offset, 4)
    if (fourCc === 'VP8 ') {
      // chunk data(自 offset+8 起)：frame tag(3) + start code(3) + width(2 LE) + height(2 LE)
      const width = u16le(bytes, offset + 14)
      const height = u16le(bytes, offset + 16)
      if (width === 0 || height === 0) return null
      return { width, height }
    }
    if (fourCc === 'VP8L') {
      // chunk data(自 offset+8 起)：签名 0x2f + 28-bit LSB 打包：width-1(14) + height-1(14)
      const b1 = bytes[offset + 9] ?? 0
      const b2 = bytes[offset + 10] ?? 0
      const b3 = bytes[offset + 11] ?? 0
      const b4 = bytes[offset + 12] ?? 0
      const width = (b1 | ((b2 & 0x3f) << 8)) + 1
      const height = (((b2 >> 6) & 0x3) | (b3 << 2) | ((b4 & 0x0f) << 10)) + 1
      if (width === 0 || height === 0) return null
      return { width, height }
    }
    if (fourCc === 'VP8X') {
      const width = u24le(bytes, offset + 12) + 1
      const height = u24le(bytes, offset + 15) + 1
      if (width === 0 || height === 0) return null
      return { width, height }
    }
    const chunkSize = u32be(bytes, offset + 4)
    offset += 8 + chunkSize
  }
  return null
}

export function probeImage(bytes: Uint8Array, mimeType: string): ProbedImage | null {
  if (mimeType === 'image/png') return pngSize(bytes)
  if (mimeType === 'image/jpeg') return jpegSize(bytes)
  if (mimeType === 'image/webp') return webpSize(bytes)
  return null
}

// ---------------------------------------------------------------------------
// 音频时长
// ---------------------------------------------------------------------------

const EBML_ID_EBML_HEADER = 0x1a45dfa3
const EBML_ID_SEGMENT = 0x18538067
const EBML_ID_INFO = 0x1549a966
const EBML_ID_TIMECODE_SCALE = 0x2ad7b1
const EBML_ID_DURATION = 0x4489
const EBML_ID_CLUSTER = 0x1f43b675
const EBML_ID_TIMECODE = 0xe7
/** Cluster 里的块：`SimpleBlock` 与 `BlockGroup` 里的 `Block`。 */
const EBML_ID_SIMPLE_BLOCK = 0xa3
const EBML_ID_BLOCK_GROUP = 0xa0
const EBML_ID_BLOCK = 0xa1

/** 默认 1ms per unit（Matroska 规范里的 TimestampScale 默认值）。 */
const DEFAULT_TIMECODE_SCALE = 1_000_000

/** EBML 元素 ID 的 raw 字节长度：首字节从最高位向下数连续 1 的个数。 */
function ebmlVintLength(firstByte: number): number {
  if (firstByte === 0) return 0
  let length = 1
  let mask = 0x80
  while (length <= 8 && (firstByte & mask) === 0) {
    length += 1
    mask >>= 1
  }
  return length
}

/** EBML 元素 ID：raw 字节直接拼大整数（ID 不去标记位）。 */
function ebmlIdValue(bytes: Uint8Array, offset: number, length: number): number {
  let value = 0
  for (let i = 0; i < length; i++) value = value * 256 + (bytes[offset + i] ?? 0)
  return value
}

/** EBML size：去标记位（首字节 `0x80 >> (length-1)` 为标记）。 */
function ebmlSizeValue(bytes: Uint8Array, offset: number, length: number): number {
  const marker = 0x80 >> (length - 1)
  let value = (bytes[offset] ?? 0) & (marker - 1)
  for (let i = 1; i < length; i++) value = value * 256 + (bytes[offset + i] ?? 0)
  return value
}

/**
 * EBML **Unsigned Integer Element Data**：普通大端无符号整数，**不是** VINT。
 *
 * `TimecodeScale` / `Timecode` / `FlagDefault` 等都用它。绝不能走 `ebmlSizeValue()`：
 * 那里会剥掉首字节的最高位（标记位），而 uint 数据的最高位是**数据位**。
 * 实测差别：`89981`（3 字节 `0x01 0x5F 0x7D`）被 VINT 解码成 `46461`，
 * 让 59s 的 MediaRecorder 录音看起来只有 9.8s（评审 blocker 2）。
 */
function readUnsignedIntBE(bytes: Uint8Array, offset: number, length: number): number {
  let value = 0
  for (let i = 0; i < length; i++) value = value * 256 + (bytes[offset + i] ?? 0)
  return value
}

/** EBML Float Element Data：4 或 8 字节 IEEE-754 大端。 */
function readFloatBE(bytes: Uint8Array, offset: number, length: number): number | null {
  if (offset + length > bytes.length) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, length)
  if (length === 4) return view.getFloat32(0, false)
  if (length === 8) return view.getFloat64(0, false)
  return null
}

/** 解析出的 EBML 子元素：`dataStart`/`dataEnd` 指向 Element Data。 */
type EbmlElement = { id: number; dataStart: number; dataEnd: number }

/**
 * 遍历 `[start, end)` 内的 EBML 子元素。
 *
 * 与旧实现的关键差别：**每个分支都必须前进**。旧写法在 `size === 0` 时 `continue` 而不推进
 * `pos`，遇到合法的空元素（size 0）会原地自旋把 API 卡死（攻击者可用它做 DoS）。
 * 这里的 `cursor = dataEnd` 保证 size 0 也会越过元素头，循环必然收敛。
 */
function walkEbmlElements(
  bytes: Uint8Array,
  start: number,
  end: number,
  visit: (element: EbmlElement) => void,
): void {
  let cursor = start
  while (cursor < end) {
    const idLength = ebmlVintLength(bytes[cursor] ?? 0)
    if (idLength === 0) return
    const id = ebmlIdValue(bytes, cursor, idLength)
    cursor += idLength
    if (cursor >= end) return

    const sizeLength = ebmlVintLength(bytes[cursor] ?? 0)
    if (sizeLength === 0) return
    const size = ebmlSizeValue(bytes, cursor, sizeLength)
    cursor += sizeLength

    // size 可能是"未知"（全 1，如流式 WebM 的 Segment）：收敛到块尾。
    const dataStart = cursor
    const dataEnd = Math.min(end, dataStart + size)
    visit({ id, dataStart, dataEnd })
    cursor = dataEnd
  }
}

/**
 * 估算 WebM 时长：取最后一个 Cluster 里**最晚的块时间戳**。
 *
 * 关键（评审 blocker 2 的第二半）：Cluster 的 `Timecode` 只是**该块开始**的时刻，
 * 每个 Block 还有一个相对它的有符号 16-bit 偏移（SimpleBlock / Block 尾部的
 * `TrackNumber(vint) + int16 BE`）。一个 Cluster 可以包含很多块（ffmpeg 的
 * `-cluster_time_limit 1000000` 会把整段录音塞进一个 Cluster），此时只看 Cluster Timecode
 * 会**严重低估**时长：实测 61s / 130s 的单 Cluster 文件分别只算出 32.8s / 98.3s，
 * 其中 61s 那个能直接绕过 60s 上限。
 *
 * 因此取 `timecode + max(相对偏移)`。偏移为负数时忽略（时间戳不应倒退），
 * 取不到任何 Block 时退化为 Cluster Timecode（至少不比自己更差）。
 */
function lastClusterEndTimecode(bytes: Uint8Array, start: number, end: number): number | null {
  let lastEnd: number | null = null

  walkEbmlElements(bytes, start, end, (element) => {
    if (element.id !== EBML_ID_CLUSTER) return

    let clusterTimecode: number | null = null
    let maxBlockOffset = 0

    walkEbmlElements(bytes, element.dataStart, element.dataEnd, (child) => {
      const size = child.dataEnd - child.dataStart
      if (size === 0) return
      if (child.id === EBML_ID_TIMECODE) {
        clusterTimecode = readUnsignedIntBE(bytes, child.dataStart, Math.min(size, 8))
        return
      }
      if (child.id === EBML_ID_SIMPLE_BLOCK) {
        // SimpleBlock：TrackNumber(vint) + int16 BE 相对时间戳 + flags + frame data
        const offset = readBlockRelativeOffset(bytes, child.dataStart, child.dataEnd)
        if (offset !== null && offset > maxBlockOffset) maxBlockOffset = offset
        return
      }
      if (child.id === EBML_ID_BLOCK_GROUP) {
        // BlockGroup → Block：同样的布局。
        walkEbmlElements(bytes, child.dataStart, child.dataEnd, (grouped) => {
          if (grouped.id !== EBML_ID_BLOCK) return
          const offset = readBlockRelativeOffset(bytes, grouped.dataStart, grouped.dataEnd)
          if (offset !== null && offset > maxBlockOffset) maxBlockOffset = offset
        })
      }
    })

    if (clusterTimecode === null) return
    const endTimecode = clusterTimecode + maxBlockOffset
    if (lastEnd === null || endTimecode > lastEnd) lastEnd = endTimecode
  })

  return lastEnd
}

/**
 * 从 `SimpleBlock` / `Block` 的 Element Data 里读相对时间戳（有符号 16-bit BE）。
 *
 * 结构：`TrackNumber`(EBML vint) + `int16` 大端（相对 Cluster Timecode，单位 = TimecodeScale）。
 * 读不到合法值返回 null（调用方退化为只用 Cluster Timecode）。
 */
function readBlockRelativeOffset(bytes: Uint8Array, start: number, end: number): number | null {
  const trackNumberLength = ebmlVintLength(bytes[start] ?? 0)
  if (trackNumberLength === 0) return null
  const offsetStart = start + trackNumberLength
  if (offsetStart + 2 > end) return null
  // `<< 16 >> 16` 做有符号扩展（时间戳可以是负数：B 帧先于 Cluster Timecode）。
  const raw = ((bytes[offsetStart] ?? 0) << 8) | (bytes[offsetStart + 1] ?? 0)
  return (raw << 16) >> 16
}

/**
 * WebM（EBML）：Segment → Info → (TimecodeScale, Duration)，缺失时退化为最后 Cluster 的 Timecode。
 *
 * 必须是完整文件字节；只读头部无法得到正确的 fallback 值（见 `lastClusterTimecode`）。
 */
function webmDuration(bytes: Uint8Array): ProbedDuration | null {
  // 1) EBML Header：ID + size + payload；随后应紧跟 Segment。
  let cursor = 0
  const headerIdLength = ebmlVintLength(bytes[0] ?? 0)
  if (headerIdLength === 0) return null
  if (ebmlIdValue(bytes, 0, headerIdLength) !== EBML_ID_EBML_HEADER) return null
  cursor = headerIdLength
  if (cursor >= bytes.length) return null
  const headerSizeLength = ebmlVintLength(bytes[cursor] ?? 0)
  if (headerSizeLength === 0) return null
  const headerSize = ebmlSizeValue(bytes, cursor, headerSizeLength)
  cursor += headerSizeLength + headerSize

  // 2) Segment
  if (cursor + 1 >= bytes.length) return null
  const segmentIdLength = ebmlVintLength(bytes[cursor] ?? 0)
  if (segmentIdLength === 0) return null
  if (ebmlIdValue(bytes, cursor, segmentIdLength) !== EBML_ID_SEGMENT) return null
  cursor += segmentIdLength
  const segmentSizeLength = ebmlVintLength(bytes[cursor] ?? 0)
  if (segmentSizeLength === 0) return null
  const segmentSize = ebmlSizeValue(bytes, cursor, segmentSizeLength)
  cursor += segmentSizeLength
  const segmentEnd = Math.min(bytes.length, cursor + segmentSize)

  let timecodeScale = DEFAULT_TIMECODE_SCALE
  let durationMs: number | null = null

  // 3) Segment 子元素：Info 里取 TimecodeScale / Duration。
  walkEbmlElements(bytes, cursor, segmentEnd, (element) => {
    if (element.id !== EBML_ID_INFO) return
    walkEbmlElements(bytes, element.dataStart, element.dataEnd, (field) => {
      const size = field.dataEnd - field.dataStart
      if (size === 0) return
      if (field.id === EBML_ID_TIMECODE_SCALE) {
        timecodeScale = readUnsignedIntBE(bytes, field.dataStart, Math.min(size, 8))
      } else if (field.id === EBML_ID_DURATION) {
        // Duration 是 EBML Float（4 或 8 字节），单位是 TimecodeScale 的 tick 数。
        const value = readFloatBE(bytes, field.dataStart, size)
        if (value !== null && Number.isFinite(value) && value > 0) {
          durationMs = (value * timecodeScale) / 1_000_000
        }
      }
    })
  })

  if (durationMs !== null) {
    // 服务端唯一的用途是**安全上限**，所以这里的取向是 fail-closed：
    // MediaRecorder / 流式 WebM 写不写 Duration 都合法，而一个被篡改的文件可以声明一个
    // 远比实际短的 Duration。因此不能只信 Info.Duration —— 拿块时间戳推出的下界取大值：
    // 两者不一致（声明值 < 块实际跨度）时以块为准。一个纯 WebM 必然有 Cluster，
    // 拿不到块时间戳时保持 null，让调用方 fail-closed。
    const blockEnd = lastClusterEndTimecode(bytes, cursor, segmentEnd)
    if (blockEnd === null) return { durationMs: Math.max(0, Math.round(durationMs)) }
    const blockEndMs = (blockEnd * timecodeScale) / 1_000_000
    return { durationMs: Math.max(0, Math.round(Math.max(durationMs, blockEndMs))) }
  }

  // 4) 没有 Duration（MediaRecorder 流式 WebM 的常态）：用最后一个 Cluster 的**结束**时间戳。
  const endTimecode = lastClusterEndTimecode(bytes, cursor, segmentEnd)
  if (endTimecode === null) return null
  return {
    durationMs: Math.max(0, Math.round((endTimecode * timecodeScale) / 1_000_000)),
  }
}

/** MP4 box 头：size(4) + type(4)，size 支持 1（64-bit largesize）与 0（到文件尾）。 */
function readBox(
  bytes: Uint8Array,
  offset: number,
): { type: string; start: number; end: number } | null {
  if (offset + 8 > bytes.length) return null
  let size = u32be(bytes, offset)
  const type = ascii(bytes, offset + 4, 4)
  if (size === 0) return { type, start: offset + 8, end: bytes.length }
  if (size === 1) {
    if (offset + 16 > bytes.length) return null
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset + 8, 8)
    size = Number(view.getBigUint64(0, false))
  }
  if (size < 8 || offset + size > bytes.length) return null
  return { type, start: offset + 8, end: offset + size }
}

/**
 * MP4：优先用 `moov` 里的**样本表**（`stts`）推出真实时长，并与 `mvhd` 取较大值。
 *
 * 不单独信任 `mvhd.duration`：它只是头部整数，篒改后能把真实 65s 报成 1s 从而捧过 60s 上限
 * （评审 F-1）。`moov` 可以在文件尾（非 faststart 的录制文件常如此），所以同样需要完整文件字节。
 */
function mp4Duration(bytes: Uint8Array): ProbedDuration | null {
  let moov: { start: number; end: number } | null = null
  for (let offset = 0; offset + 8 <= bytes.length; ) {
    const box = readBox(bytes, offset)
    if (!box) return null
    if (box.type === 'moov') {
      moov = box
      break
    }
    offset = box.end
  }
  if (!moov) return null

  const candidates = [
    readMvhdDurationMs(bytes, moov),
    mp4SampleTableDurationMs(bytes, moov),
  ].filter((value): value is number => value !== null)
  if (candidates.length === 0) return null
  return { durationMs: Math.max(0, Math.round(Math.max(...candidates))) }
}

/**
 * `moov/mvhd` 声明的时长（毫秒）；缺失/不可用返回 null。
 *
 * 这只是**头部整数**，可被篡改，所以调用方必须与样本表推出的值取 max。
 */
function readMvhdDurationMs(
  bytes: Uint8Array,
  moov: { start: number; end: number },
): number | null {
  for (let pos = moov.start; pos + 8 <= moov.end; ) {
    const box = readBox(bytes, pos)
    if (!box) return null
    pos = box.end
    if (box.type !== 'mvhd') continue

    const version = bytes[box.start] ?? 0
    // mvhd data：version+flags(4) | creation | modification | timescale(4) | duration
    const timescale = u32be(bytes, box.start + (version === 1 ? 20 : 12))
    if (timescale === 0) return null
    const duration =
      version === 1
        ? Number(
            new DataView(bytes.buffer, bytes.byteOffset + box.start + 24, 8).getBigUint64(0, false),
          )
        : u32be(bytes, box.start + 16)
    if (duration === 0) return null
    return (duration / timescale) * 1000
  }
  return null
}

/**
 * 从**样本表**推出媒体时长（毫秒）：`trak/mdia/mdhd`(timescale) + `stbl/stts`(每样本 tick 数)。
 *
 * 这是评审 F-1 的修复点：真时长在样本表里，而不在 `mvhd.duration` 头部整数里。
 * 实测：把真实 65s 的 `mvhd.duration` 改成 1s，ffprobe 仍报 65s（它读样本表），但只读 mvhd
 * 的实现会报 1s 而捧过 60s 上限。
 *
 * 取向与 WebM 那侧一致：取所有 trak 的最大值（宁可高估不得低估）；任何一项读不完整
 * （entryCount 与实际数据不符）就跳过该 trak，不用**不完整的和**参与比较。
 */
function mp4SampleTableDurationMs(
  bytes: Uint8Array,
  moov: { start: number; end: number },
): number | null {
  let maxMs: number | null = null

  for (let pos = moov.start; pos + 8 <= moov.end; ) {
    const trak = readBox(bytes, pos)
    if (!trak) break
    pos = trak.end
    if (trak.type !== 'trak') continue

    const mdia = findBoxInRange(bytes, trak.start, trak.end, 'mdia')
    if (!mdia) continue

    const mdhd = findBoxInRange(bytes, mdia.start, mdia.end, 'mdhd')
    if (!mdhd) continue
    const version = bytes[mdhd.start] ?? 0
    // mdhd data：version+flags(4) | creation | modification | timescale(4) | duration
    const timescale = u32be(bytes, mdhd.start + (version === 1 ? 20 : 12))
    if (timescale === 0) continue

    const minf = findBoxInRange(bytes, mdia.start, mdia.end, 'minf')
    if (!minf) continue
    const stbl = findBoxInRange(bytes, minf.start, minf.end, 'stbl')
    if (!stbl) continue
    const stts = findBoxInRange(bytes, stbl.start, stbl.end, 'stts')
    if (!stts) continue

    // stts data：version+flags(4) | entryCount(4) | (count(4), delta(4))*
    const entryCount = u32be(bytes, stts.start + 4)
    let cursor = stts.start + 8
    let totalTicks = 0
    let truncated = false
    for (let i = 0; i < entryCount; i++) {
      if (cursor + 8 > stts.end) {
        truncated = true
        break
      }
      totalTicks += u32be(bytes, cursor) * u32be(bytes, cursor + 4)
      cursor += 8
    }
    // 截断时**不要**用不完整的和去参与 max（会低估，正是攻击者想要的方向）。
    if (truncated) continue

    const ms = (totalTicks / timescale) * 1000
    if (Number.isFinite(ms) && (maxMs === null || ms > maxMs)) maxMs = ms
  }

  return maxMs
}

/** 在 `[start, end)` 内找第一个 `type` 的 box。 */
function findBoxInRange(
  bytes: Uint8Array,
  start: number,
  end: number,
  type: string,
): { start: number; end: number } | null {
  for (let pos = start; pos + 8 <= end; ) {
    const box = readBox(bytes, pos)
    if (!box) return null
    if (box.type === type) return { start: box.start, end: box.end }
    pos = box.end
  }
  return null
}

/**
 * 语音真实时长。
 *
 * `bytes` 必须是**完整对象**：WebM 的 `Duration` 缺失 fallback 与 MP4 的 `moov` 位置
 * 都要求看到文件末尾，只喂头部会低估时长并绕过 60s 上限（评审 blocker 2）。
 */
export function probeVoiceDuration(bytes: Uint8Array, mimeType: string): ProbedDuration | null {
  if (mimeType === 'audio/webm') return webmDuration(bytes)
  if (mimeType === 'audio/mp4') return mp4Duration(bytes)
  return null
}
