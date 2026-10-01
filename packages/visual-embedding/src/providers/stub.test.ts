import { expect, test } from 'bun:test'
import { VISUAL_EMBEDDING_DIMENSIONS } from '@fish/db/schema/visual-embeddings'
import { createStubVisualEmbeddingProvider, STUB_VISUAL_EMBEDDING_MODEL } from './stub'

/**
 * stub provider 的单测：不出网、不碰数据库，只钉住"确定性 + 单位长度"这两条集成测试依赖的性质。
 * 视觉检索集成测试要断言"拿商品封面本身当查询图，该商品排第一"，靠的就是自相似度 = 1。
 */
const provider = createStubVisualEmbeddingProvider()

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6, 5])

function norm(vector: number[]): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
}

function dot(a: number[], b: number[]): number {
  let total = 0
  for (let index = 0; index < a.length; index += 1) total += (a[index] ?? 0) * (b[index] ?? 0)
  return total
}

test('声明符合 provider 契约，且同一图片字节永远得到同一向量', async () => {
  expect(provider.model).toBe(STUB_VISUAL_EMBEDDING_MODEL)
  expect(provider.dimensions).toBe(VISUAL_EMBEDDING_DIMENSIONS)

  const first = await provider.embedImage(PNG_BYTES, 'image/png')
  const again = await provider.embedImage(PNG_BYTES, 'image/png')

  expect(first).toHaveLength(VISUAL_EMBEDDING_DIMENSIONS)
  // 确定性是"内容指纹相同就不重复生成"能成立的前提：否则每次生成都要重新计费。
  expect(first).toEqual(again)
})

test('输出是 L2 单位向量（图片与文本都归一化）', async () => {
  const image = await provider.embedImage(PNG_BYTES, 'image/png')
  const text = await provider.embedText('红色球鞋')

  expect(norm(image)).toBeCloseTo(1, 6)
  expect(norm(text)).toBeCloseTo(1, 6)
})

test('mime 参与哈希：同样的字节换个声明类型就是另一个向量', async () => {
  const asPng = await provider.embedImage(PNG_BYTES, 'image/png')
  const asJpeg = await provider.embedImage(PNG_BYTES, 'image/jpeg')

  // 服务端不信客户端 MIME：声明类型一变向量就该变，否则这条纪律在向量空间里不可观察。
  expect(asPng).not.toEqual(asJpeg)
})

test('不同字节得到不同向量', async () => {
  const png = await provider.embedImage(PNG_BYTES, 'image/png')
  const jpeg = await provider.embedImage(JPEG_BYTES, 'image/png')

  expect(png).not.toEqual(jpeg)
})

test('embedText 确定性：相同文本同一向量，不同文本不同向量', async () => {
  const first = await provider.embedText('红色球鞋')
  const again = await provider.embedText('红色球鞋')
  const other = await provider.embedText('蓝色外套')

  expect(first).toEqual(again)
  expect(first).not.toEqual(other)
})

test('自相似度为 1：拿封面本身当查询图时余弦距离为 0（集成测试的召回顺序依赖它）', async () => {
  const cover = await provider.embedImage(PNG_BYTES, 'image/png')
  const query = await provider.embedImage(PNG_BYTES, 'image/png')
  const text = await provider.embedText('红色球鞋')

  expect(dot(cover, query)).toBeCloseTo(1, 6)
  expect(dot(text, text)).toBeCloseTo(1, 6)
})

test('退化输入仍是有限单位向量：空图片字节走哈希，空文本走固定方向', async () => {
  const emptyImage = await provider.embedImage(new Uint8Array(0), 'image/png')
  expect(emptyImage).toHaveLength(VISUAL_EMBEDDING_DIMENSIONS)
  expect(emptyImage.every((value) => Number.isFinite(value))).toBe(true)
  expect(norm(emptyImage)).toBeCloseTo(1, 6)

  const emptyText = await provider.embedText('')
  // 零向量会让余弦无定义：stub 显式给一个固定方向，而不是返回全 0。
  expect(emptyText[0]).toBe(1)
  expect(emptyText.slice(1).every((value) => value === 0)).toBe(true)
  expect(norm(emptyText)).toBeCloseTo(1, 6)
})
