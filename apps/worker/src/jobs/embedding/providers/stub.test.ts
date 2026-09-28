import { expect, test } from 'bun:test'
import { EMBEDDING_DIMENSIONS } from '@fish/db/schema/embeddings'
import { createStubEmbeddingProvider, STUB_EMBEDDING_MODEL } from './stub'

const provider = createStubEmbeddingProvider()

function cosine(a: number[], b: number[]): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0)
  return dot
}

test('声明与返回都符合 provider 契约：1536 维、L2 归一化', async () => {
  expect(provider.model).toBe(STUB_EMBEDDING_MODEL)
  expect(provider.dimensions).toBe(EMBEDDING_DIMENSIONS)

  const [vector] = await provider.embed(['K380 机械键盘 青轴'])
  expect(vector).toHaveLength(EMBEDDING_DIMENSIONS)
  const norm = Math.sqrt((vector ?? []).reduce((sum, value) => sum + value * value, 0))
  expect(norm).toBeCloseTo(1, 6)
})

test('确定性：同一文本永远得到同一向量，不同文本得到不同向量', async () => {
  const [first] = await provider.embed(['苹果降噪耳机'])
  const [again] = await provider.embed(['苹果降噪耳机'])
  const [other] = await provider.embed(['AirPods Pro 2 USB-C'])

  // 确定性是"内容指纹相同就不重复生成"能成立的前提：否则每次生成都要重新计费。
  expect(first).toEqual(again)
  expect(first).not.toEqual(other)
})

test('共享词元的文本余弦相似度更高（stub 也必须有语义顺序，否则召回测试无意义）', async () => {
  const [a] = await provider.embed(['k380 mechanical keyboard'])
  const [related] = await provider.embed(['k380 mechanical keyboard switch'])
  const [unrelated] = await provider.embed(['索尼降噪头戴耳机'])

  const relatedScore = cosine(a ?? [], related ?? [])
  const unrelatedScore = cosine(a ?? [], unrelated ?? [])

  expect(relatedScore).toBeGreaterThan(0)
  expect(relatedScore).toBeGreaterThan(unrelatedScore)
})

test('全空文本给固定方向而不是零向量（零向量会让余弦无定义）', async () => {
  const [punctuation] = await provider.embed(['！！！'])
  expect(punctuation?.[0]).toBe(1)
  expect((punctuation ?? []).slice(1).every((value) => value === 0)).toBe(true)

  const [empty] = await provider.embed([''])
  expect(empty).toEqual(punctuation)
})

test('批量返回顺序与入参一致', async () => {
  const texts = ['alpha', 'beta', 'gamma']
  const vectors = await provider.embed(texts)
  expect(vectors).toHaveLength(3)
  for (const [index, text] of texts.entries()) {
    const [single] = await provider.embed([text])
    expect(vectors[index]).toEqual(single)
  }
})
