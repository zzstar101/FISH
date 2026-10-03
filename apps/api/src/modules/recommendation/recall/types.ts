/**
 * R3 多路召回的内部类型（Issue #323 M2/M3）。
 *
 * 这些类型**不进 `@fish/contracts`**：契约描述的是跨进程边界（HTTP 请求/响应、DB 枚举），而这里
 * 描述的是"本次召回在 API 进程里长什么样"——候选池、每路的 feature、降级原因。R4 的 ranker 是它
 * 的第一个下游，届时按需从这里导出，而不是提前把内部形状固化成公共契约。
 */

import type { ListingCategory } from '@fish/contracts/listings/schema'
import type { RecallChannel } from '@fish/contracts/recommendation/recall'

/**
 * 单路降级原因（Issue #323 M2 要求"单路失败可降级"且可对账）。
 *
 * - `no_profile`：这一路需要兴趣画像/身份，而本次请求没有（匿名且无会话行为、或已登录但画像为空）。
 * - `model_unavailable`：需要 embedding 模型真值，而装配处没给（`embeddingModel === null`）。
 * - `provider_error`：查询或聚合抛错。**不含**"这一路本来就该是空的"——那是 `candidateCount: 0`
 *   且 `degradedReason: null`，两者必须能区分，否则监控会把正常空路当成故障。
 */
export type RecallDegradeReason = 'no_profile' | 'model_unavailable' | 'provider_error'

/** 单路的执行结果：供 R6 的线上指标与排障使用。 */
export type RecallChannelOutcome = {
  channel: RecallChannel
  /**
   * 该路返回的候选数。**未经跨路去重、未过最终可见性复核**（复核在合并层，按整层算）：
   * 这个数字的用途是"这一路本身出了多少候选"，把它和合并后的候选数相减才知道通道重叠度。
   */
  candidateCount: number
  degradedReason: RecallDegradeReason | null
}

/**
 * 一路的原始候选。
 *
 * `score` 的含义由通道决定（semantic = 1 − cosine 距离、wish = #322 匹配分、popular = 衰减热度），
 * fresh/category/explore 没有自己的分值，传 `null`。用同一个字段而不是六个可选字段，是因为合并层
 * 只需要"把这个值搬到对应的 feature 列上"，通道语义由 `channel` 决定。
 */
export type ChannelCandidate = {
  listingId: string
  score: number | null
}

/** 一路的候选列表 + 该路的降级原因。 */
export type ChannelRecall = {
  channel: RecallChannel
  candidates: readonly ChannelCandidate[]
  degradedReason: RecallDegradeReason | null
}

/**
 * 合并去重后的候选（Issue #323 M3 的字段清单）。
 *
 * `recallSources` 按 `RECALL_CHANNEL_PRIORITY` 从高到低排列（最多 `RECALL_MAX_SOURCES_PER_CANDIDATE`
 * 条）；所有 feature 列都保留，**不因为"已经命中过更强的通道"就丢掉弱通道带来的 feature**。
 */
export type RecallCandidate = {
  listingId: string
  sellerId: string
  category: ListingCategory
  recallSources: RecallChannel[]
  semanticScore: number | null
  wishScore: number | null
  popularity: number | null
  userCategoryAffinity: number | null
  freshness: number
  createdAt: Date
  /**
   * 该用户看过这件商品的次数；`null` = **未知**（曝光计数查询失败，或无身份）。
   *
   * R3 时这里写死 `number` 且失败退化成 0，等于把"不知道"谎报成"没看过"—— R4 的排序把它当
   * 惩罚项用，两种含义会直接改变排序结果，因此必须区分（R3 §9 待办①）。
   */
  alreadySeenCount: number | null
  sellerExposure: number
}

/** 本次召回的兴趣画像使用情况（布尔而非向量：向量不该出现在日志/调试输出里）。 */
export type RecallInterestUsage = {
  session: boolean
  longTerm: boolean
  combined: boolean
}

/** 召回层产出：候选 + 逐路对账 + 兴趣使用情况。 */
export type RecallResult = {
  strategyVersion: string
  candidates: RecallCandidate[]
  channels: RecallChannelOutcome[]
  interest: RecallInterestUsage
  /**
   * 合并阶段的降级原因，`null` = 正常。两种情形：
   * - 最终可见性复核失败 ⇒ `candidates` 为空（没有"此刻可见"的真值就不输出候选）；
   * - 曝光次数读取失败 ⇒ `candidates` 照常返回，只是 `alreadySeenCount` 全为 `null`（未知，
   *   不是 0 —— 排序层据此把 `repeatedExposure` 记入 `missing`，而不是当"确实没看过"加满分）。
   * 两者都归 `provider_error`，但后果不同，因此调用方要按 `candidates` 是否为空一起判读。
   */
  mergeDegradedReason: RecallDegradeReason | null
}
