/**
 * 负反馈信号构造（#323 R4 / M4 的 `negativeFeedbackPenalty`）。
 *
 * 纯函数：不查库。输入是 `aggregateNegativeFeedback` 的 SQL 聚合（#524），
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
  RANK_NEGATIVE_FEEDBACK_EVENT_TYPES,
  RANK_NEGATIVE_FEEDBACK_HALF_SATURATION,
  RANK_NEGATIVE_FEEDBACK_WEIGHTS,
  saturatingRatio,
} from '@fish/contracts/recommendation/rank'
import type { NegativeFeedbackAggregate } from '@fish/db/recall-store'

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

/**
 * 喂给 `aggregateNegativeFeedback` 的权重表：`|INTEREST_ACTION_WEIGHTS[t]|`（HIDE 3 / UNFAVORITE 2 /
 * QUICK_SKIP 0.5）。同一个"这个行为有多负"只在 R2 的画像权重表里定义一次；衰减用 R2 的**长期**
 * 半衰期（`NEGATIVE_FEEDBACK_HALF_LIFE_MS`）：负反馈是"我对这类东西的态度"，不该半小时就复位。
 */
export const NEGATIVE_FEEDBACK_SQL_WEIGHTS = RANK_NEGATIVE_FEEDBACK_EVENT_TYPES.map(
  (eventType) => ({ eventType, weight: RANK_NEGATIVE_FEEDBACK_WEIGHTS[eventType] }),
)

export const NEGATIVE_FEEDBACK_HALF_LIFE_MS = INTEREST_HALF_LIFE_MS.longTerm

/**
 * SQL 聚合（`aggregateNegativeFeedback`，#524）→ 排序层信号：只做饱和映射。
 *
 * v1 在这里把窗口内全部原始事件逐条衰减累加，查询无上界；v2 把"衰减 × 权重 × 分组求和"
 * 下推到 SQL，返回行数受类目枚举与候选数约束，这里只剩 `saturatingRatio`。
 */
export function buildNegativeFeedbackSignals(
  aggregate: NegativeFeedbackAggregate,
): NegativeFeedbackSignals {
  const normalize = (rows: readonly { key: string; weight: number }[]): Map<string, number> =>
    new Map(
      rows
        .filter((row) => Number.isFinite(row.weight) && row.weight > 0)
        .map((row) => [
          row.key,
          saturatingRatio(row.weight, RANK_NEGATIVE_FEEDBACK_HALF_SATURATION),
        ]),
    )

  return {
    hiddenListingIds: new Set(aggregate.hiddenListingIds),
    categoryPenalty: normalize(
      aggregate.categoryWeights.map((row) => ({ key: row.category, weight: row.weight })),
    ),
    sellerPenalty: normalize(
      aggregate.sellerWeights.map((row) => ({ key: row.sellerId, weight: row.weight })),
    ),
  }
}

/** 没有任何负反馈时的空信号（无身份、冷启动、或查询失败后的降级值）。 */
export function emptyNegativeFeedbackSignals(): NegativeFeedbackSignals {
  return { hiddenListingIds: new Set(), categoryPenalty: new Map(), sellerPenalty: new Map() }
}
