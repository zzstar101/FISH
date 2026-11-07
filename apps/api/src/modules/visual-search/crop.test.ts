import { describe, expect, spyOn, test } from 'bun:test'
import {
  analyzeQueryImage,
  cropSubject,
  decodePng,
  encodePng,
  type RasterImage,
  subjectCropRect,
  VISUAL_WORKING_IMAGE_MAX_SIDE,
  workingImageOf,
} from './crop'
import { createVisualParser } from './parse'

test('解析关闭时不生成工作图，原始字节和 MIME 直接用于整图检索', async () => {
  const image = encodePng(gradient(200, 100))
  const resize = spyOn(Bun.Image.prototype, 'resize')
  try {
    const result = await analyzeQueryImage(
      image,
      'image/png',
      createVisualParser({ transport: 'off' }),
    )
    expect(result.image).toBe(image)
    expect(result.mime).toBe('image/png')
    expect(result.interpretation).toBeNull()
    expect(result.subjectBox).toBeNull()
    expect(resize).not.toHaveBeenCalled()
  } finally {
    resize.mockRestore()
  }
})

/** 每个像素的 RGB 都由坐标算出来：裁剪 / 解码出错时能看出偏到了哪一格。 */
function gradient(width: number, height: number): RasterImage {
  const pixels = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      pixels.set([x & 0xff, y & 0xff, (x * 7 + y * 13) & 0xff], (y * width + x) * 3)
    }
  }
  return { width, height, channels: 3, pixels }
}

/** 给 JPEG 插一段只含 `Orientation = 6`（顺时针转 90°）的 EXIF APP1。 */
function withOrientation6(jpeg: Uint8Array): Uint8Array {
  const tiff = [0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0]
  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff, 0, 0, 0, 0]
  const length = payload.length + 2
  return Uint8Array.from([
    ...jpeg.subarray(0, 2),
    0xff,
    0xe1,
    length >> 8,
    length & 0xff,
    ...payload,
    ...jpeg.subarray(2),
  ])
}

describe('subjectCropRect', () => {
  test('四周各外扩框宽 / 高的 8%，再夹回图内', () => {
    // 框 x 0.25–0.75、y 0.25–0.75；外扩 0.04 ⇒ 0.21–0.79 ⇒ 1000 宽里的 210–790。
    expect(subjectCropRect({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, 1000, 500)).toEqual({
      left: 210,
      top: 105,
      width: 580,
      height: 290,
    })
    // 贴边的框外扩后不越界。
    expect(subjectCropRect({ x: 0, y: 0, width: 1, height: 1 }, 640, 480)).toEqual({
      left: 0,
      top: 0,
      width: 640,
      height: 480,
    })
  })

  test('外扩后仍有一边不足 32 像素 ⇒ 不裁', () => {
    expect(subjectCropRect({ x: 0.5, y: 0.5, width: 0.01, height: 0.5 }, 1000, 1000)).toBeNull()
    expect(subjectCropRect({ x: 0.5, y: 0.5, width: 0.5, height: 0.2 }, 1000, 100)).toBeNull()
  })
})

describe('PNG 拆装', () => {
  test('Bun.Image 默认压缩（行过滤 1–4 都会用到）的 PNG 解出的像素与原图逐字节相同', async () => {
    const source = gradient(97, 61)
    const filteredPng = await new Bun.Image(encodePng(source)).png().bytes()

    const decoded = decodePng(filteredPng)

    expect(decoded?.width).toBe(97)
    expect(decoded?.height).toBe(61)
    // Bun.Image 的 PNG 输出是 RGBA：逐像素比 RGB，alpha 全不透明。
    if (!decoded) throw new Error('应当解得出')
    for (let index = 0; index < 97 * 61; index += 1) {
      const rgba = Array.from(decoded.pixels.subarray(index * 4, index * 4 + 4))
      expect(rgba).toEqual([...source.pixels.subarray(index * 3, index * 3 + 3), 255])
    }
  })

  test('不是 PNG / 隔行之类不支持的形状 ⇒ null，而不是抛错', () => {
    expect(decodePng(new Uint8Array([1, 2, 3]))).toBeNull()
    const png = encodePng(gradient(4, 4))
    png[28] = 1 // IHDR 的 interlace 字节（签名 8 + 长度 4 + 类型 4 + 宽高 8 + 4 个字节）
    expect(decodePng(png)).toBeNull()
  })
})

describe('cropSubject', () => {
  test('裁出的正是框（含外扩）内的像素', async () => {
    const source = gradient(200, 100)
    const working = await new Bun.Image(encodePng(source)).png().bytes()

    // 外扩后 x 92–200、y 0–100（同 subjectCropRect 的算法）。
    const cropped = await cropSubject(working, { x: 0.5, y: 0, width: 0.5, height: 1 })

    if (!cropped) throw new Error('应当裁得出')
    const raster = decodePng(await new Bun.Image(cropped).png({ compressionLevel: 0 }).bytes())
    expect(raster?.width).toBe(108)
    expect(raster?.height).toBe(100)
    // JPEG 有损：抽查左上角像素接近原图 (92, 0) 的颜色。
    const [r, g] = raster?.pixels ?? []
    expect(Math.abs((r ?? 0) - 92)).toBeLessThan(12)
    expect(Math.abs(g ?? 0)).toBeLessThan(12)
  })

  test('框太小 / 输入不是图 ⇒ null（调用方退回整图）', async () => {
    const working = encodePng(gradient(200, 100))
    expect(await cropSubject(working, { x: 0, y: 0, width: 0.01, height: 0.01 })).toBeNull()
    expect(
      await cropSubject(new Uint8Array([1, 2, 3]), { x: 0, y: 0, width: 1, height: 1 }),
    ).toBeNull()
  })
})

describe('workingImageOf', () => {
  test('按 EXIF 方向摆正、长边缩到上限，输出不再带 EXIF 的 JPEG', async () => {
    const jpeg = await new Bun.Image(encodePng(gradient(2400, 1200))).jpeg().bytes()

    const working = await workingImageOf(withOrientation6(jpeg))

    if (!working) throw new Error('应当生成工作图')
    // 关掉 autoOrient 读到的就是像素本身的宽高：已经是竖图，说明转正落在了像素里。
    const meta = await new Bun.Image(working, { autoOrient: false }).metadata()
    expect(meta.format).toBe('jpeg')
    expect({ width: meta.width, height: meta.height }).toEqual({
      width: VISUAL_WORKING_IMAGE_MAX_SIDE / 2,
      height: VISUAL_WORKING_IMAGE_MAX_SIDE,
    })
  })

  test('小图不放大；不是图 ⇒ null', async () => {
    const working = await workingImageOf(encodePng(gradient(300, 200)))
    if (!working) throw new Error('应当生成工作图')
    const meta = await new Bun.Image(working).metadata()
    expect({ width: meta.width, height: meta.height }).toEqual({ width: 300, height: 200 })

    expect(await workingImageOf(new Uint8Array([1, 2, 3]))).toBeNull()
  })
})
