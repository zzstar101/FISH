/**
 * 推荐读侧 embedding 模型的启动自检（#524）。
 *
 * API 按 `EMBEDDING_MODEL` 过滤 `embeddings` 行，worker 用同一个变量写向量。两边配得不一致时，
 * 语义召回、会话兴趣、长期画像全部**静默落空** —— 查询不报错，只是永远查不到行，推荐退化成
 * 热门 + 新品，线上没有任何信号（v1 就这样跑了一段时间）。
 *
 * 判定只看一个指纹：库里**有**商品向量，但**没有一条**属于当前模型。空库（新环境、向量还没
 * 回填）不算配错。发现配错只记 `console.error` + 进程内指标，**不让进程崩**：推荐是旁路能力，
 * 不能因为它让整个 API 起不来；而 env 层面的硬错误（live 缺 `EMBEDDING_MODEL`）已经在
 * `loadRecommendationEmbeddingModel()` 里让启动失败了。
 */

export type EmbeddingModelCheckResult = 'ok' | 'empty' | 'mismatch' | 'error'

export async function checkRecommendationEmbeddingModel(deps: {
  model: string
  countListingEmbeddings: (model: string) => Promise<{ total: number; matching: number }>
  onMismatch?: () => void
}): Promise<EmbeddingModelCheckResult> {
  let counts: { total: number; matching: number }
  try {
    counts = await deps.countListingEmbeddings(deps.model)
  } catch (error) {
    console.warn('[recommendation] embedding 模型自检查询失败，跳过：', error)
    return 'error'
  }
  if (counts.total === 0) return 'empty'
  if (counts.matching > 0) return 'ok'

  deps.onMismatch?.()
  console.error(
    JSON.stringify({
      event: 'recommendation.embedding_model_mismatch',
      model: deps.model,
      listingEmbeddings: counts.total,
      hint: 'API 与 worker 的 EMBEDDING_MODEL 不一致：语义召回与兴趣画像将全部落空',
    }),
  )
  return 'mismatch'
}
