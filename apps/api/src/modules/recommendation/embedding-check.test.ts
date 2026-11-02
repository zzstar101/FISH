import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { checkRecommendationEmbeddingModel } from './embedding-check'

describe('checkRecommendationEmbeddingModel（#524）', () => {
  afterEach(() => {
    mock.restore()
  })

  test('库里有商品向量但没有一条属于当前模型 ⇒ mismatch：记指标 + console.error，不抛', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    const onMismatch = mock(() => {})

    const result = await checkRecommendationEmbeddingModel({
      model: 'qwen3.7-text-embedding',
      countListingEmbeddings: async () => ({ total: 22, matching: 0 }),
      onMismatch,
    })

    expect(result).toBe('mismatch')
    expect(onMismatch).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('recommendation.embedding_model_mismatch')
  })

  test('空库不算配错；有匹配行即 ok；查询失败不让启动失败', async () => {
    const onMismatch = mock(() => {})
    spyOn(console, 'warn').mockImplementation(() => {})

    expect(
      await checkRecommendationEmbeddingModel({
        model: 'm',
        countListingEmbeddings: async () => ({ total: 0, matching: 0 }),
        onMismatch,
      }),
    ).toBe('empty')
    expect(
      await checkRecommendationEmbeddingModel({
        model: 'm',
        countListingEmbeddings: async () => ({ total: 5, matching: 3 }),
        onMismatch,
      }),
    ).toBe('ok')
    expect(
      await checkRecommendationEmbeddingModel({
        model: 'm',
        countListingEmbeddings: async () => {
          throw new Error('db down')
        },
        onMismatch,
      }),
    ).toBe('error')
    expect(onMismatch).not.toHaveBeenCalled()
  })
})
