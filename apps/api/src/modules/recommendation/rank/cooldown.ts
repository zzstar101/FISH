/**
 * 重复曝光冷却的判据（#323 M6）。
 *
 * M6 原文：「同一个商品反复曝光但用户持续不点：降权；达到阈值后短期冷却。用户主动再次搜索 /
 * Wish 命中时允许重新进入。」降权由 `repeatedExposure` 特征承担（`score.ts` + 契约里的
 * `RANK_FEATURE_WEIGHTS`），这里只负责"要不要干脆别发"，即**硬排除**。
 *
 * 这是一个纯函数：输入是"这批候选的历史聚合值 + 当前时间"，没有任何 IO，也不看召回通道
 * （`wish` 豁免在重排层做，见 `rerank.ts`）。拆出来的理由与 `score.ts` 相同 —— 判据要能被单测
 * 穷举边界（恰好 24 小时、历史缺失、已互动过），而不是只能靠集成测试碰运气。
 */

import {
  RANK_REPEATED_EXPOSURE_COOLDOWN_MS,
  RANK_REPEATED_EXPOSURE_COOLDOWN_THRESHOLD,
} from '@fish/contracts/recommendation/rank'

/** 一件商品的曝光/互动历史聚合（由 `packages/db` 的 `findExposureHistory` 产出）。 */
export type ExposureHistoryEntry = {
  /** 归因曝光（`IMPRESSION`）次数，不设窗口 —— "反复曝光"没有自然的时间下界。 */
  exposureCount: number
  /** 最后一次归因曝光时间；一次都没曝光过时为 `null`。 */
  lastExposedAt: Date | null
  /** 归因互动（`RANK_COOLDOWN_ENGAGEMENT_EVENT_TYPES`）次数。 */
  engagedCount: number
}

/**
 * 冷却集合：`history` 里同时满足"没互动过 + 曝光到阈值 + 距最后一次曝光不足 24 小时"的商品。
 *
 * 判据刻意用 `>= COOLDOWN_MS` 就放行（而不是 `>`）：冷却从最后一次曝光起算恰好 24 小时**结束**，
 * 这样 `lastExposedAt = now - 24h` 是可写进测试的确定边界，不会出现"差一毫秒还在冷却"的模糊地带。
 * 未来时间（时钟偏移）按"刚曝光过"处理，留在冷却里更安全 —— 多压一轮只是少推一件，提前放行却会
 * 让用户立刻又看到它。
 */
export function cooldownListingIds(input: {
  history: ReadonlyMap<string, ExposureHistoryEntry>
  now: Date
}): ReadonlySet<string> {
  const cooldown = new Set<string>()
  const nowMs = input.now.getTime()

  for (const [listingId, entry] of input.history) {
    if (entry.engagedCount > 0) continue
    if (entry.exposureCount < RANK_REPEATED_EXPOSURE_COOLDOWN_THRESHOLD) continue
    if (entry.lastExposedAt === null) continue
    if (nowMs - entry.lastExposedAt.getTime() >= RANK_REPEATED_EXPOSURE_COOLDOWN_MS) continue
    cooldown.add(listingId)
  }

  return cooldown
}
