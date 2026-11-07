// PNG 的 IDAT 是带 zlib 头的流；`Bun.deflateSync` 产出的是裸 DEFLATE，不能直接用，所以走 node:zlib。
import { deflateSync, inflateSync } from 'node:zlib'
import type { VisualImageMime } from '@fish/contracts/visual/provider'
import {
  MAX_VISUAL_QUERY_IMAGE_PIXELS,
  type VisualInterpretation,
  type VisualSubjectBox,
} from '@fish/contracts/visual/schema'
import type { VisualParser } from './parse'

/**
 * 查询图的主体裁剪（#584）：解析模型给出主体框后，只拿框内区域去向量化。
 *
 * ## 工作图：先摆正、缩小，解析与裁剪用同一张
 *
 * 主体框的坐标系必须与客户端显示的图一致，而客户端显示的是**按 EXIF 方向摆正后**的图。
 * 解析模型是否认 EXIF 方向不可控，所以不把原图直接给它：先用 `Bun.Image` 摆正（它默认
 * `autoOrient`，重编码后不再带 EXIF）并把长边缩到 `VISUAL_WORKING_IMAGE_MAX_SIDE`，解析与裁剪
 * 都用这一张 —— 框天然落在"摆正后"的坐标系里，长边缩小也让解析的图片 token 不随原图分辨率涨。
 *
 * ## 为什么要自己拆 PNG
 *
 * `Bun.Image` 只有 resize / rotate / flip，没有 crop / extract（bun 1.4.4，`bun-types` 的
 * `class Image`）。不为一次裁剪引入 `sharp` 这类原生模块：让 `Bun.Image` 把工作图解成
 * 不压缩的 PNG，按行取出框内像素，再拼一个 PNG 交回 `Bun.Image` 编成 JPEG。
 * 只认 8 位 RGB / RGBA、非隔行（`Bun.Image` 的 PNG 输出就是这种），其余形状一律当失败处理。
 *
 * ## 失败一律退回整图
 *
 * 裁剪是增强而不是前提：任一步失败都返回 `null`，调用方按整图检索，与没有框时完全一致。
 */

/** 工作图长边上限：与上游多模态模型的默认像素预算同一量级，再大只是多花 token。 */
export const VISUAL_WORKING_IMAGE_MAX_SIDE = 1600

/**
 * 主体框四周各外扩框宽/高的这个比例：模型给的框贴着物体边缘，留一圈背景
 * 与商品封面图（通常不是贴边裁的）的构图更接近。
 */
export const VISUAL_SUBJECT_PADDING = 0.08

/** 裁剪区域任一边短于这个像素数就不裁：太小的框不是"主体"，而是模型框到了某个细节。 */
export const VISUAL_SUBJECT_MIN_SIDE_PX = 32

const JPEG_QUALITY = 90

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export type RasterImage = {
  width: number
  height: number
  /** 每像素字节数：3 = RGB，4 = RGBA。 */
  channels: 3 | 4
  /** 逐行紧排的像素，长度 = `width * height * channels`。 */
  pixels: Uint8Array
}

export type PixelRect = { left: number; top: number; width: number; height: number }

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) return String(error.code)
  return error instanceof Error ? error.name : 'unknown'
}

/**
 * 摆正 + 缩小后的 JPEG 工作图；解码失败（不是图 / 格式不支持 / 像素超限）返回 `null`。
 * 像素上限与入口校验同一个常量：入口已经按图片头挡过一次，这里是解码器自己的那道闸。
 */
export async function workingImageOf(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    return await new Bun.Image(bytes, { maxPixels: MAX_VISUAL_QUERY_IMAGE_PIXELS })
      .resize(VISUAL_WORKING_IMAGE_MAX_SIDE, VISUAL_WORKING_IMAGE_MAX_SIDE, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: JPEG_QUALITY })
      .bytes()
  } catch (error) {
    console.warn(`[visual-search] 工作图生成失败：${errorCode(error)}`)
    return null
  }
}

/**
 * 主体框 → 工作图上的像素矩形（外扩 `VISUAL_SUBJECT_PADDING`、夹回图内）。
 * 外扩后仍有一边短于 `VISUAL_SUBJECT_MIN_SIDE_PX` 返回 `null`（不裁）。
 */
export function subjectCropRect(
  box: VisualSubjectBox,
  imageWidth: number,
  imageHeight: number,
): PixelRect | null {
  const padX = box.width * VISUAL_SUBJECT_PADDING
  const padY = box.height * VISUAL_SUBJECT_PADDING
  const left = Math.max(0, Math.floor((box.x - padX) * imageWidth))
  const top = Math.max(0, Math.floor((box.y - padY) * imageHeight))
  const right = Math.min(imageWidth, Math.ceil((box.x + box.width + padX) * imageWidth))
  const bottom = Math.min(imageHeight, Math.ceil((box.y + box.height + padY) * imageHeight))
  const width = right - left
  const height = bottom - top
  if (width < VISUAL_SUBJECT_MIN_SIDE_PX || height < VISUAL_SUBJECT_MIN_SIDE_PX) return null
  return { left, top, width, height }
}

/** 主体区域的 JPEG；框太小或任一步失败返回 `null`（调用方退回整图）。 */
export async function cropSubject(
  workingImage: Uint8Array,
  box: VisualSubjectBox,
): Promise<Uint8Array | null> {
  try {
    const raster = decodePng(await new Bun.Image(workingImage).png({ compressionLevel: 0 }).bytes())
    if (!raster) {
      console.warn('[visual-search] 主体裁剪：工作图的 PNG 形状不受支持')
      return null
    }
    const rect = subjectCropRect(box, raster.width, raster.height)
    if (!rect) return null
    return await new Bun.Image(encodePng(cropRaster(raster, rect)))
      .jpeg({ quality: JPEG_QUALITY })
      .bytes()
  } catch (error) {
    console.warn(`[visual-search] 主体裁剪失败：${errorCode(error)}`)
    return null
  }
}

/** 一张查询图分析完之后：解析结论、实际采用的主体框，以及该拿去向量化的那张图。 */
export type AnalyzedQueryImage = {
  interpretation: VisualInterpretation | null
  /**
   * 只在**真的按它裁了**时非 `null`：没裁成就不能让客户端画框。
   * 返回的是模型给的原框；实际向量化的区域是它外扩 `VISUAL_SUBJECT_PADDING` 之后的那块。
   */
  subjectBox: VisualSubjectBox | null
  /** 有主体时是主体裁剪的 JPEG，否则就是原图（字节与 MIME 原样）。 */
  image: Uint8Array
  mime: VisualImageMime
}

/**
 * 查询图 → 解析 + 主体裁剪（#584）。线上检索（`./service.ts`）与离线评测
 * （`apps/api/scripts/visual-eval-subject.ts`）走同一个函数，评测量到的就是线上那条路。
 *
 * 解析看的是工作图（见文件头），框才与客户端显示的图同一坐标系；工作图生成失败就把原图交给
 * 解析、且不裁剪 —— 那时框的坐标系无法保证。
 */
export async function analyzeQueryImage(
  bytes: Uint8Array,
  mime: VisualImageMime,
  parser: VisualParser,
): Promise<AnalyzedQueryImage> {
  if (!parser.enabled) {
    return { interpretation: null, subjectBox: null, image: bytes, mime }
  }
  const workingImage = await workingImageOf(bytes)
  if (!workingImage) {
    const parsed = await parser.parse(bytes, mime)
    return { interpretation: parsed.interpretation, subjectBox: null, image: bytes, mime }
  }
  const parsed = await parser.parse(workingImage, 'image/jpeg')
  const subject = parsed.subjectBox ? await cropSubject(workingImage, parsed.subjectBox) : null
  return subject
    ? {
        interpretation: parsed.interpretation,
        subjectBox: parsed.subjectBox,
        image: subject,
        mime: 'image/jpeg',
      }
    : { interpretation: parsed.interpretation, subjectBox: null, image: bytes, mime }
}

export function cropRaster(raster: RasterImage, rect: PixelRect): RasterImage {
  const rowBytes = rect.width * raster.channels
  const pixels = new Uint8Array(rowBytes * rect.height)
  for (let row = 0; row < rect.height; row += 1) {
    const start = ((rect.top + row) * raster.width + rect.left) * raster.channels
    pixels.set(raster.pixels.subarray(start, start + rowBytes), row * rowBytes)
  }
  return { width: rect.width, height: rect.height, channels: raster.channels, pixels }
}

/** PNG 的 Paeth 预测器（PNG 规范 9.4）。 */
function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft
  const toLeft = Math.abs(estimate - left)
  const toUp = Math.abs(estimate - up)
  const toUpLeft = Math.abs(estimate - upLeft)
  if (toLeft <= toUp && toLeft <= toUpLeft) return left
  return toUp <= toUpLeft ? up : upLeft
}

/** 8 位 RGB / RGBA、非隔行 PNG → 像素；其余形状（调色板、16 位、隔行、坏数据）返回 `null`。 */
export function decodePng(png: Uint8Array): RasterImage | null {
  if (png.length < 8 || PNG_SIGNATURE.some((byte, index) => png[index] !== byte)) return null
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)

  let width = 0
  let height = 0
  let channels: 3 | 4 | null = null
  const data: Uint8Array[] = []
  for (let offset = 8; offset + 12 <= png.length; ) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8))
    const body = png.subarray(offset + 8, offset + 8 + length)
    if (body.length !== length) return null
    if (type === 'IHDR') {
      if (length !== 13) return null
      width = view.getUint32(offset + 8)
      height = view.getUint32(offset + 12)
      const [bitDepth, colorType, , , interlace] = body.subarray(8)
      if (bitDepth !== 8 || interlace !== 0) return null
      channels = colorType === 2 ? 3 : colorType === 6 ? 4 : null
      if (channels === null) return null
    } else if (type === 'IDAT') {
      data.push(body)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  if (channels === null || width === 0 || height === 0) return null

  const filtered = inflateSync(Buffer.concat(data))
  const rowBytes = width * channels
  if (filtered.length < (rowBytes + 1) * height) return null

  const pixels = new Uint8Array(rowBytes * height)
  for (let row = 0; row < height; row += 1) {
    const filter = filtered[row * (rowBytes + 1)]
    const source = filtered.subarray(row * (rowBytes + 1) + 1, (row + 1) * (rowBytes + 1))
    const out = row * rowBytes
    // 不压缩输出的每一行都是过滤类型 0：整行拷贝，不逐字节预测。
    if (filter === 0) {
      pixels.set(source, out)
      continue
    }
    for (let index = 0; index < rowBytes; index += 1) {
      const left = index >= channels ? (pixels[out + index - channels] ?? 0) : 0
      const up = row > 0 ? (pixels[out - rowBytes + index] ?? 0) : 0
      const upLeft =
        row > 0 && index >= channels ? (pixels[out - rowBytes + index - channels] ?? 0) : 0
      const raw = source[index] ?? 0
      let predicted: number
      if (filter === 1) predicted = left
      else if (filter === 2) predicted = up
      else if (filter === 3) predicted = (left + up) >> 1
      else if (filter === 4) predicted = paeth(left, up, upLeft)
      else return null
      pixels[out + index] = (raw + predicted) & 0xff
    }
  }
  return { width, height, channels, pixels }
}

function pngChunk(type: string, body: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + body.length)
  const view = new DataView(chunk.buffer)
  view.setUint32(0, body.length)
  for (let index = 0; index < 4; index += 1) chunk[4 + index] = type.charCodeAt(index)
  chunk.set(body, 8)
  view.setUint32(8 + body.length, Bun.hash.crc32(chunk.subarray(4, 8 + body.length)))
  return chunk
}

/** 像素 → PNG（每行过滤类型 0；只给 `Bun.Image` 当中间格式，不追求体积）。 */
export function encodePng(raster: RasterImage): Uint8Array {
  const rowBytes = raster.width * raster.channels
  const filtered = new Uint8Array((rowBytes + 1) * raster.height)
  for (let row = 0; row < raster.height; row += 1) {
    filtered.set(
      raster.pixels.subarray(row * rowBytes, (row + 1) * rowBytes),
      row * (rowBytes + 1) + 1,
    )
  }
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, raster.width)
  view.setUint32(4, raster.height)
  header[8] = 8
  header[9] = raster.channels === 4 ? 6 : 2
  return Buffer.concat([
    Uint8Array.from(PNG_SIGNATURE),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(filtered, { level: 1 })),
    pngChunk('IEND', new Uint8Array(0)),
  ])
}
