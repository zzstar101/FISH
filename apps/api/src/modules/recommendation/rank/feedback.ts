/**
 * 负反馈信号构造（#323 R4 / M4 的 `negativeFeedbackPenalty`）。
 *
 * 纯函数：不查库、不读时钟以外的东西。输入是 `findNegativeFeedbackEvents` 的原始事件行，
 * 输出给排序层与重排层共用的两类信号：
 *
 * - **listing 级硬排除**（`hiddenListingIds`）：M6「已划走/隐藏的内容不重复推荐」；
 * - **类目/卖家级软惩罚**（`categoryPenalty` / `sellerPenalty`）：用户对"这类内容/这家卖家"
 *   的整体态度，作为排序特征参与打分。
 *
 * 为什么两者分开而不是都做成硬排除：一件商品踩中某个不喜欢的类目，不等于这件商品本身不想要
 * （用户可能就是在这个类目里挑）。硬排除只留给**针对这一件商品**的明确表态。
 */

import { INTEREST_HALF_LIFE_MS } from '@fish/contracts/recommendation/interest'
import {
  RANK_HIDDEN_EVENT_TYPES,
  RANK_NEGATIVE_FEEDBACK_HALF_SATURATION,
  RANK_NEGATIVE_FEEDBACK_WEIGHTS,
  saturatingRatio,
} from '@fish/contracts/recommendation/rank'
import type { NegativeFeedbackEvent } from '@fish/db/recall-store'

export type NegativeFeedbackSignals = {
  /** 本次不应再出现的商品（listing 级硬排除）。 */
  hiddenListingIds: ReadonlySet<string>
  /** 类目 → 软惩罚 `[0, 1)`。 */
  categoryPenalty: ReadonlyMap<string, number>
  /** 卖家 → 软惩罚 `[0, 1)`。 */
  sellerPenalty: ReadonlyMap<string, number>
}

/** 该候选的负反馈强度：类目与卖家取 `max`。 */
export function pickNegativeFeedback(
  signals: NegativeFeedbackSignals,
  candidate: { category: string; sellerId: string },
): number {
  const byCategory = signals.categoryPenalty.get(candidate.category) ?? 0
  const bySeller = signals.sellerPenalty.get(candidate.sellerId) ?? 0
  // **取 max 而不是相加**：一件商品同时踩中不喜欢的类目与不喜欢的卖家时，两边的证据是同一件
  // 事（"我不想要这类/这家的东西"），相加会让惩罚无界逼近 1，把软惩罚悄悄变成硬排除。
  return Math.max(byCategory, bySeller)
}

const HIDDEN_EVENT_TYPES: ReadonlySet<string> = new Set(RANK_HIDDEN_EVENT_TYPES)

/**
 * 权重表的查表副本。
 *
 * 事件行的 `eventType` 是**全量**枚举（DB 列的类型），而权重表只有三个键，直接下标会以
 * "索引签名不存在"编译失败；用 `Map` 查表既不需要断言，也让"不在表里的类型权重为 0"成为
 * 显式的缺省值而不是隐式行为（`findNegativeFeedbackEvents` 已经按事件类型过滤过，这里是兜底）。
 */
const WEIGHT_BY_EVENT_TYPE: ReadonlyMap<string, number> = new Map(
  Object.entries(RANK_NEGATIVE_FEEDBACK_WEIGHTS),
)

/**
 * 时间衰减后的负反馈权重：`|actionWeight| × 0.5 ** (age / 长期半衰期)`。
 *
 * 权重取 `|INTEREST_ACTION_WEIGHTS[t]|`（HIDE 3 / UNFAVORITE 2 / QUICK_SKIP 0.5）：同一个
 * "这个行为有多负"只在 R2 的画像权重表里定义一次。半衰期用 R2 的**长期**口径（14 天）而不是
 * session 口径（30 分钟）：负反馈是"我对这类东西的态度"，不该因为半小时没动作就复位。
 */
function decayedWeight(event: NegativeFeedbackEvent, now: Date): number {
  const weight = WEIGHT_BY_EVENT_TYPE.get(event.eventType) ?? 0
  const ageMs = now.getTime() - event.occurredAt.getTime()
  // 非法/未来时间戳按"刚刚发生"（age = 0）算满权重，而不是让 NaN 传播进累加。
  const decay = Number.isFinite(ageMs)
    ? 0.5 ** (Math.max(ageMs, 0) / INTEREST_HALF_LIFE_MS.longTerm)
    : 1
  return weight * decay
}

export function buildNegativeFeedbackSignals(input: {
  events: readonly NegativeFeedbackEvent[]
  now: Date
}): NegativeFeedbackSignals {
  const hiddenListingIds = new Set<string>()
  const categoryWeights = new Map<string, number>()
  const sellerWeights = new Map<string, number>()

  for (const event of input.events) {
    if (HIDDEN_EVENT_TYPES.has(event.eventType)) hiddenListingIds.add(event.listingId)

    const weight = decayedWeight(event, input.now)
    if (weight === 0) continue
    categoryWeights.set(event.category, (categoryWeights.get(event.category) ?? 0) + weight)
    sellerWeights.set(event.sellerId, (sellerWeights.get(event.sellerId) ?? 0) + weight)
  }

  const normalize = (weights: Map<string, number>): Map<string, number> =>
    new Map(
      [...weights].map(([key, value]) => [
        key,
        saturatingRatio(value, RANK_NEGATIVE_FEEDBACK_HALF_SATURATION),
      ]),
    )

  return {
    hiddenListingIds,
    categoryPenalty: normalize(categoryWeights),
    sellerPenalty: normalize(sellerWeights),
  }
}

/** 没有任何负反馈时的空信号（无身份、冷启动、或查询失败后的降级值）。 */
export function emptyNegativeFeedbackSignals(): NegativeFeedbackSignals {
  return { hiddenListingIds: new Set(), categoryPenalty: new Map(), sellerPenalty: new Map() }
}
