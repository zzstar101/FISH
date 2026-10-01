import {
  VISUAL_FRESHNESS_HALF_LIFE_DAYS,
  VISUAL_POPULARITY_SATURATION,
  VISUAL_RANKING_WEIGHTS,
  VISUAL_SEARCH_STRATEGY_VERSION,
  type VisualScoreBreakdown,
} from '@fish/contracts/visual/ranking'

/**
 * 混合排序（#324 M6）：把两路召回的距离与结构化信号合成一个分数。
 *
 * 权重与半衰期**全部**来自 `@fish/contracts/visual/ranking`，这里不写任何字面量——
 * 权重是产品口径，改它必须同时改 `VISUAL_SEARCH_STRATEGY_VERSION`，
 * 两个值放在同一个文件里才有可能同时被改到。
 *
 * 这个模块是纯函数：没有 IO、没有时钟（`now` 由调用方传入），所以权重组合的正确性
 * 可以只用表驱动单测钉住，不需要数据库。
 */

/** 召回候选数（两路各取这么多，再合并）。取 60 是因为重排只在前 30 名上有意义。 */
export const VISUAL_RECALL_LIMIT = 60

/** 响应条数上限。契约没有分页，"看图找同款"一次给 30 条已经超出用户会翻的量。 */
export const VISUAL_RESULT_LIMIT = 30

/**
 * pgvector 的 cosine **距离** → 相似度。
 *
 * `<=>` 的范围是 [0, 2]，0 = 同向。这里线性映射到 [0, 1] 并夹紧：
 * 归一化向量理论上不会越界，但 live 上游不保证归一化（`dimension_mismatch` 之外没有别的校验），
 * 一个未归一化的向量会让距离超过 2 从而产生负分，把排序彻底打乱。
 */
export function similarityFromCosineDistance(distance: number): number {
  if (!Number.isFinite(distance)) return 0
  return Math.min(1, Math.max(0, 1 - distance / 2))
}

/** 新鲜度：`0.5 ** (ageDays / HALF_LIFE_DAYS)`。未来时间戳（时钟偏移）按 1 处理。 */
export function freshnessScore(createdAt: Date, now: Date): number {
  const ageMs = now.getTime() - createdAt.getTime()
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1
  const ageDays = ageMs / 86_400_000
  return 0.5 ** (ageDays / VISUAL_FRESHNESS_HALF_LIFE_DAYS)
}

/**
 * 热度：收藏数 / 饱和点，夹在 [0, 1]。
 * 用饱和而不是"除以本结果集最大值"：后者会让同一件商品在不同查询里热度不同。
 */
export function popularityScore(favoriteCount: number): number {
  if (!Number.isFinite(favoriteCount) || favoriteCount <= 0) return 0
  return Math.min(1, favoriteCount / VISUAL_POPULARITY_SATURATION)
}

export type VisualCandidateScoreInput = {
  /** 图片路召回的相似度；只被文本路召回时传 0（没有图片相似度就是没有，不用平均值伪造）。 */
  visualScore: number
  /** OCR/VLM 文本与候选封面向量的相似度；未解析出文本时为 `null`。 */
  textScore: number | null
  /** 分类是否与解析结果一致（1/0）；未解析出分类时为 `null`。 */
  categoryScore: number | null
  freshnessScore: number
  popularityScore: number
}

/**
 * 合成分数。
 *
 * **缺失的分项连同权重一起剔除，剩余权重按比例归一化**（`totalWeight` 除回来）。
 * 这一条是刻意的：如果缺项按 0 分计入，那么"没解析出文本"的结果会被无差别压低 0.2，
 * 而且"解析得越少排得越后"——解析是可选增强，不该惩罚检索结果。
 * 与 #322 的 `semanticScore === null → 退回 v1 排序` 同一纪律。
 */
export function scoreVisualCandidate(input: VisualCandidateScoreInput): VisualScoreBreakdown {
  const terms: Array<[number, number]> = [[VISUAL_RANKING_WEIGHTS.visual, input.visualScore]]
  if (input.textScore !== null) terms.push([VISUAL_RANKING_WEIGHTS.text, input.textScore])
  if (input.categoryScore !== null) {
    terms.push([VISUAL_RANKING_WEIGHTS.category, input.categoryScore])
  }
  terms.push([VISUAL_RANKING_WEIGHTS.freshness, input.freshnessScore])
  terms.push([VISUAL_RANKING_WEIGHTS.popularity, input.popularityScore])

  const totalWeight = terms.reduce((sum, [weight]) => sum + weight, 0)
  const score =
    totalWeight > 0
      ? terms.reduce((sum, [weight, value]) => sum + weight * value, 0) / totalWeight
      : 0

  return {
    score,
    visualScore: input.visualScore,
    textScore: input.textScore,
    categoryScore: input.categoryScore,
    freshnessScore: input.freshnessScore,
    popularityScore: input.popularityScore,
    strategyVersion: VISUAL_SEARCH_STRATEGY_VERSION,
  }
}
