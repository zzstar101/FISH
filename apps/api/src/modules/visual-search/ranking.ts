import type { ListingCard } from '@fish/contracts/listings/schema'
import {
  VISUAL_CONDITION_RANK,
  VISUAL_FRESHNESS_HALF_LIFE_DAYS,
  VISUAL_POPULARITY_SATURATION,
  VISUAL_RANKING_WEIGHTS,
  VISUAL_SEARCH_STRATEGY_VERSION,
  type VisualScoreBreakdown,
} from '@fish/contracts/visual/ranking'
import type { VisualSearchSort } from '@fish/contracts/visual/schema'

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

/**
 * 参与排序的候选：**混排之后、截断之前**的条目形状。
 *
 * 只声明排序真正读到的字段（而不是把 service 里的整个中间结构搬过来），
 * 这样这个纯函数不会被"多带了一个字段"之类的无关改动牵动。
 */
export type VisualScoredCandidate = {
  card: ListingCard
  ranking: VisualScoreBreakdown
  /** 想要数（来自 `loadListingSignals`），`popular` 档的排序键。 */
  favoriteCount: number
}

/**
 * 五档服务端排序（#324 M6）。
 *
 * 纯函数：无 IO、无时钟、不修改入参，返回新数组。必须在 `.slice(0, LIMIT)` **之前**调用——
 * 否则"最新"只会重排已经截断的前 30 条，而不是全局最新的 30 条。
 *
 * 每一档在各自的排序键之后，都统一落到「混合分降序 → 图片相似度降序 → 公开 id 升序」：
 * 排序键是产品口径；中间那层是 M6 之前的既有口径（见 `compareByScoreThenVisualThenId`），
 * 最后一层是**确定性**——同输入必须同输出，否则同一个查询两次会给出不同顺序，
 * 而客户端会把它当成"结果变了"。
 *
 * 排序键只影响呈现顺序、不参与 `scoreVisualCandidate`，所以不触碰
 * `VISUAL_RANKING_WEIGHTS`，也不递增 `VISUAL_SEARCH_STRATEGY_VERSION`。
 */
export function orderVisualCandidates<T extends VisualScoredCandidate>(
  candidates: readonly T[],
  sort: VisualSearchSort,
): T[] {
  return [...candidates].sort((left, right) => {
    const primary = compareBySortKey(left, right, sort)
    if (primary !== 0) return primary
    return compareByScoreThenVisualThenId(left, right)
  })
}

/** 各档的排序键。`relevance` 没有额外键：它的排序键就是下面的统一兜底。 */
function compareBySortKey(
  left: VisualScoredCandidate,
  right: VisualScoredCandidate,
  sort: VisualSearchSort,
): number {
  switch (sort) {
    case 'relevance':
      return 0
    case 'popular':
      return right.favoriteCount - left.favoriteCount
    case 'newest':
      return Date.parse(right.card.createdAt) - Date.parse(left.card.createdAt)
    case 'price_asc':
      return left.card.priceCents - right.card.priceCents
    case 'condition':
      return (
        VISUAL_CONDITION_RANK[left.card.condition] - VISUAL_CONDITION_RANK[right.card.condition]
      )
  }
}

/**
 * 统一兜底：混合分降序 → 图片相似度降序 → 公开 id 升序。
 *
 * 中间那层是 M6 之前 `service.ts` 里就有的口径，原文注释：「同分先看图片相似度：纯文本命中的
 * 候选（visualScore = 0）排在有图片证据的之后。」`relevance` 档的排序键为空、全部候选都落到
 * 这里，所以这一层对缺省档就是实际生效的次级键；删掉它等于把同分排序退化成「按随机 id」。
 *
 * `id` 是公开 ID，天然唯一且稳定，保证同输入同输出。
 */
function compareByScoreThenVisualThenId(
  left: VisualScoredCandidate,
  right: VisualScoredCandidate,
): number {
  if (right.ranking.score !== left.ranking.score) {
    return right.ranking.score - left.ranking.score
  }
  if (right.ranking.visualScore !== left.ranking.visualScore) {
    return right.ranking.visualScore - left.ranking.visualScore
  }
  return left.card.id.localeCompare(right.card.id)
}
