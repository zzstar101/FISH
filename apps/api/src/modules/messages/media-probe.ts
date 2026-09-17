/**
 * 媒体真实尺寸 / 真实时长的服务端解析（fix-plan F5 / Q3=B1）。
 *
 * 只读文件头/容器结构，不解码整文件，零第三方依赖：
 * - 图片尺寸：PNG(IHDR) / JPEG(SOFn) / WebP(VP8/VP8L/VP8X)
 * - 语音时长：WebM(EBML Segment→Info→Duration，退化用最后 Cluster Timecode) / MP4(mvhd)
 *
 * 所有解析失败均返回 null，由调用方 fail-closed（拒绝上传），
 * 不信任客户端声明的 width/height/durationMs。
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

const EBML_ID_SEGMENT = 0x18538067
const EBML_ID_INFO = 0x1549a966
const EBML_ID_TIMECODE_SCALE = 0x2ad7b1
const EBML_ID_DURATION = 0x4489
const EBML_ID_CLUSTER = 0x1f43b675
const EBML_ID_TIMECODE = 0xe7

/** EBML vint（ID / size）长度：首字节从最高位向下数连续 1 的个数。 */
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

/** EBML size / uint 字段：去标记位（首字节 `0x80 >> (length-1)` 为标记）。 */
function ebmlVintValue(bytes: Uint8Array, offset: number, length: number): number {
  const marker = 0x80 >> (length - 1)
  let value = (bytes[offset] ?? 0) & (marker - 1)
  for (let i = 1; i < length; i++) value = value * 256 + (bytes[offset + i] ?? 0)
  return value
}

/** 解析 8 字节 IEEE-754 double（DataView 处理大小端与对齐）。 */
function f64be(bytes: Uint8Array, offset: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8)
  return view.getFloat64(0, false)
}

/**
 * WebM（EBML）：递归不深，直接迭代。
 * 期望 Shape：Segment → Info → (TimecodeScale, Duration)。
 * MediaRecorder 的 WebM 常把 Duration 写 0/未知，退化为扫描最后一个 Cluster 的 Timecode。
 */
function webmDuration(bytes: Uint8Array): ProbedDuration | null {
  // 1) EBML Header：ID(0x1A45DFA3) + size + payload；随后应紧跟 Segment。
  let pos = 0
  const headerIdLen = ebmlVintLength(bytes[0] ?? 0)
  if (headerIdLen === 0) return null
  if (ebmlIdValue(bytes, 0, headerIdLen) !== 0x1a45dfa3) return null
  pos += headerIdLen
  const headerSizeLen = ebmlVintLength(bytes[pos] ?? 0)
  if (headerSizeLen === 0) return null
  const headerSize = ebmlVintValue(bytes, pos, headerSizeLen)
  pos += headerSizeLen + Math.min(headerSize, bytes.length - pos)

  // 2) Segment：ID(0x18538067) + size + 子元素
  if (pos + 1 >= bytes.length) return null
  const segmentIdLen = ebmlVintLength(bytes[pos] ?? 0)
  if (segmentIdLen === 0) return null
  if (ebmlIdValue(bytes, pos, segmentIdLen) !== EBML_ID_SEGMENT) return null
  pos += segmentIdLen
  const segmentSizeLen = ebmlVintLength(bytes[pos] ?? 0)
  if (segmentSizeLen === 0) return null
  // Segment size 可能是未知(全 1)，该值很大；Math.min 让它自然收敛到缓冲区末尾即可。
  const segmentSize = ebmlVintValue(bytes, pos, segmentSizeLen)
  pos += segmentSizeLen
  const segmentEnd = Math.min(bytes.length, pos + segmentSize)

  let timecodeScale = 1_000_000 // 默认 1ms per unit
  let durationMs: number | null = null
  let lastClusterTimecode: number | null = null

  // 3) 遍历 Segment 子元素
  while (pos + 1 < segmentEnd) {
    const childIdLen = ebmlVintLength(bytes[pos] ?? 0)
    if (childIdLen === 0) break
    const childId = ebmlIdValue(bytes, pos, childIdLen)
    pos += childIdLen
    const childSizeLen = ebmlVintLength(bytes[pos] ?? 0)
    if (childSizeLen === 0) break
    const childSize = ebmlVintValue(bytes, pos, childSizeLen)
    pos += childSizeLen
    if (childSize === 0) continue
    const dataStart = pos
    const dataEnd = Math.min(segmentEnd, dataStart + childSize)

    if (childId === EBML_ID_INFO) {
      let p = dataStart
      while (p + 1 < dataEnd) {
        const fieldIdLen = ebmlVintLength(bytes[p] ?? 0)
        if (fieldIdLen === 0) break
        const fieldId = ebmlIdValue(bytes, p, fieldIdLen)
        p += fieldIdLen
        const fieldSizeLen = ebmlVintLength(bytes[p] ?? 0)
        if (fieldSizeLen === 0) break
        const fieldSize = ebmlVintValue(bytes, p, fieldSizeLen)
        p += fieldSizeLen
        if (fieldSize === 0) continue
        if (fieldId === EBML_ID_TIMECODE_SCALE) {
          timecodeScale = ebmlVintValue(bytes, p, Math.min(fieldSize, 8))
        } else if (fieldId === EBML_ID_DURATION && fieldSize >= 8) {
          const value = f64be(bytes, p)
          if (Number.isFinite(value) && value > 0) {
            durationMs = (value * timecodeScale) / 1_000_000
          }
        }
        p += fieldSize
      }
    } else if (childId === EBML_ID_CLUSTER) {
      let p = dataStart
      while (p + 2 < dataEnd) {
        const fieldIdLen = ebmlVintLength(bytes[p] ?? 0)
        if (fieldIdLen === 0) break
        const fieldId = ebmlIdValue(bytes, p, fieldIdLen)
        p += fieldIdLen
        const fieldSizeLen = ebmlVintLength(bytes[p] ?? 0)
        if (fieldSizeLen === 0) break
        const fieldSize = ebmlVintValue(bytes, p, fieldSizeLen)
        p += fieldSizeLen
        if (fieldSize === 0) continue
        if (fieldId === EBML_ID_TIMECODE) {
          lastClusterTimecode = ebmlVintValue(bytes, p, Math.min(fieldSize, 8))
        }
        p += fieldSize
      }
    }
    pos = dataEnd
    if (durationMs !== null) break // 拿到明确时长就够了
  }

  if (durationMs !== null) return { durationMs: Math.max(0, Math.round(durationMs)) }
  if (lastClusterTimecode !== null) {
    // 退化：以最后一个 Cluster 的 Timecode（单位 = TimecodeScale）作为近似的累计时长。
    return {
      durationMs: Math.max(0, Math.round((lastClusterTimecode * timecodeScale) / 1_000_000)),
    }
  }
  return null
}

/** MP4：找到 moov → mvhd，duration / timescale 得到秒。 */
function mp4Duration(bytes: Uint8Array): ProbedDuration | null {
  // box: size(4) + type(4)；从根层扫描 moov
  let offset = 0
  let moovStart = -1
  while (offset + 8 <= bytes.length) {
    const size = u32be(bytes, offset)
    const type = ascii(bytes, offset + 4, 4)
    if (size === 0) break // 到文件尾
    if (type === 'moov') {
      moovStart = offset + 8
      break
    }
    if (size < 8) break
    offset += size
  }
  if (moovStart < 0) return null

  // 在 moov 内找 mvhd
  let pos = moovStart
  let mvhdStart = -1
  while (pos + 8 <= bytes.length) {
    const size = u32be(bytes, pos)
    const type = ascii(bytes, pos + 4, 4)
    if (type === 'mvhd') {
      mvhdStart = pos
      break
    }
    if (size === 0 || size < 8) break
    pos += size
  }
  if (mvhdStart < 0) return null

  const version = bytes[mvhdStart + 8] ?? 0
  // mvhd payload (mvhdStart+8 起)：version+flags(4) | creation(4/8) | modification(4/8) |
  // timescale(4) | duration(4/8)
  const timescale = u32be(bytes, version === 1 ? mvhdStart + 28 : mvhdStart + 20)
  if (timescale === 0) return null
  let duration: number
  if (version === 1) {
    // version 1：duration 8 字节在 mvhdStart+32
    const view = new DataView(bytes.buffer, bytes.byteOffset + mvhdStart + 32, 8)
    duration = Number(view.getBigUint64(0, false))
  } else {
    duration = u32be(bytes, mvhdStart + 24)
  }
  if (duration === 0) return null
  return { durationMs: Math.max(0, Math.round((duration / timescale) * 1000)) }
}

export function probeVoiceDuration(bytes: Uint8Array, mimeType: string): ProbedDuration | null {
  if (mimeType === 'audio/webm') return webmDuration(bytes)
  if (mimeType === 'audio/mp4') return mp4Duration(bytes)
  return null
}
