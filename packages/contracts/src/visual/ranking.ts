/**
 * 视觉搜索混合排序（#324 M6）的**唯一权重来源**。
 *
 * 放在契约包而不是 API/worker 内部：权重决定"什么样的商品排在前面"，是产品口径而不是实现细节，
 * 且 `visual_search_strategy_version` 必须能回答"这一版结果是用哪组权重算出来的"。
 * 改权重 = 改 version：M9 的离线对比要能把两次不同权重的结果区分开，否则回放毫无意义。
 */

import type { ListingCondition } from '../listings/schema'

/**
 * 排序策略版本。写入每次响应的 `strategyVersion` 与运行日志。
 *
 * 变更规则（与 `EMBEDDING_TEXT_FORMAT_VERSION` 同构）：只要改动权重、分项定义、
 * 或候选召回口径，就必须递增——否则历史结果无法解释。
 */
export const VISUAL_SEARCH_STRATEGY_VERSION = 'visual-hybrid-v1'

/**
 * 各分项权重，和恰为 1。
 *
 * - `visual` 占大头：这是"拍照识图"的本体，图片相似度必须主导排序。
 * - `text` 是第二路召回（M5 的 OCR/VLM 文本）与候选的封面向量算出的余弦：**只在解析出文本时**参与，
 *   否则整项剔除并把权重按比例还给其余分项（`visual === null` 时退化为纯视觉排序，
 *   与 #322 的 `semanticScore === null → 退回 v1` 同一纪律）。
 * - `category` 是硬一致性（命中 1 / 未命中 0）：目录错配的商品即使图片相似也不该靠前
 *   （"包装盒 vs 实物"这类难样本的兜底）。
 * - `freshness` / `popularity` 是小权重，避免"永远只有那几件老爆款"。
 */
export const VISUAL_RANKING_WEIGHTS = {
  visual: 0.5,
  text: 0.2,
  category: 0.15,
  freshness: 0.1,
  popularity: 0.05,
} as const

export type VisualRankingWeights = typeof VISUAL_RANKING_WEIGHTS

/**
 * 新鲜度半衰期（天）：`0.5 ** (ageDays / HALF_LIFE_DAYS)`。
 * 30 天前的商品拿到 0.5，60 天 0.25——足以让新品浮上来，又不至于把老商品压成 0。
 */
export const VISUAL_FRESHNESS_HALF_LIFE_DAYS = 30

/**
 * 热度归一化的饱和点：收藏数达到 `POPULARITY_SATURATION` 时该分项记满分。
 * 用饱和而不是除以最大值：最大值随查询结果集变化，会让"同一件商品在不同查询里热度不同"。
 */
export const VISUAL_POPULARITY_SATURATION = 20

/**
 * 成色排序序（#324 M6「成色」档）。
 *
 * 挂在 `ListingConditionSchema` 的推断类型上而不是重写一份字符串字面量：
 * 成色枚举新增一个值而这里漏配，typecheck 会当场报缺键，而不是悄悄把它排到最后。
 * 值本身（NEW 最前）是产品口径：越新的成色越该被先看到。
 */
export const VISUAL_CONDITION_RANK: Record<ListingCondition, number> = {
  NEW: 0,
  LIKE_NEW: 1,
  GOOD: 2,
  FAIR: 3,
}

/**
 * 每条候选的分数明细。**不进契约**（内部排序实现），只在服务端日志/测试里使用。
 */
export type VisualScoreBreakdown = {
  score: number
  /** 图片路相似度；只被文本路召回时为 0。 */
  visualScore: number
  /** 文本路相似度；没有解析出文本 / 文本路失败时为 `null`（该项不参与加权）。 */
  textScore: number | null
  /** 分类一致性 1/0；没有解析出分类时为 `null`（该项不参与加权）。 */
  categoryScore: number | null
  freshnessScore: number
  popularityScore: number
  strategyVersion: string
}
