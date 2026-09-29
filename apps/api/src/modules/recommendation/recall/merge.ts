/**
 * R3 候选合并 / 去重（Issue #323 M3）。
 *
 * 纯函数：不查库、不看时钟以外的东西、不打日志——输入相同必得相同输出。这样 M3 的"去重后保留所有
 * source feature"和"最终可见性再过滤"可以用 fixture 逐字断言，而不是靠集成测试间接证明。
 *
 * 两处刻意的分工：
 * 1. **可见性真值来自 `visible`**，不是召回时的快照。召回查询已经过滤过一次，但召回与合并之间
 *    商品可能被下单/下架/审核，所以合并层只认 `visible`（由 `findVisibleListingRefs` 在同一事务
 *    语义内重新读出来的结果），不在表里的候选直接丢弃。
 * 2. **`sellerExposure` 在截断前统计**：它的用途是"本次候选集内同卖家计数"，截断是输出长度控制，
 *    两者口径不同；先统计再截断保证同一批候选无论 `maxCandidates` 取多少，每个候选看到的卖家密度
 *    都一样（否则同一商品在不同 limit 下 feature 会变，R4 的排序就不可复现了）。
 */

import type { RecallChannel } from '@fish/contracts/recommendation/recall'
import {
  RECALL_CHANNEL_PRIORITY,
  RECALL_FRESHNESS_HALF_LIFE_MS,
  RECALL_MAX_CANDIDATES,
  RECALL_MAX_SOURCES_PER_CANDIDATE,
} from '@fish/contracts/recommendation/recall'
import type { ChannelRecall, RecallCandidate } from './types'

/** 合并层认可的"当前可见"商品（`findVisibleListingRefs` 的返回）。 */
export type VisibleListing = {
  listingId: string
  sellerId: string
  category: RecallCandidate['category']
  createdAt: Date
}

export type MergeRecallCandidatesInput = {
  channels: readonly ChannelRecall[]
  visible: readonly VisibleListing[]
  /** listingId → 该身份历史 IMPRESSION 次数（`countListingImpressions`）。 */
  impressions: ReadonlyMap<string, number>
  /** 类目 → 会话类目亲和（已归一化到 0–1，`findSessionCategoryWeights` 的产出）。 */
  categoryAffinity: ReadonlyMap<string, number>
  now: Date
  maxCandidates?: number
}

/** 商品新鲜度：与 Popular 通道的商品年龄衰减同一个半衰期。 */
export function freshnessOf(createdAt: Date, now: Date): number {
  const ageMs = now.getTime() - createdAt.getTime()
  // 非法 `createdAt`（数据库给了无法解析的时间）不该产出 `NaN` 传播到 R4 的排序里：记 0（最旧）。
  if (!Number.isFinite(ageMs)) return 0
  return 0.5 ** (Math.max(ageMs, 0) / RECALL_FRESHNESS_HALF_LIFE_MS)
}

const CHANNEL_PRIORITY_INDEX: ReadonlyMap<RecallChannel, number> = new Map(
  RECALL_CHANNEL_PRIORITY.map((channel, index) => [channel, index]),
)

function channelPriority(channel: RecallChannel): number {
  return CHANNEL_PRIORITY_INDEX.get(channel) ?? RECALL_CHANNEL_PRIORITY.length
}

/** 把某路的 feature 搬到对应列上；同一列已被更高优先级通道填过就保留先到的值。 */
function applyChannelFeature(
  candidate: RecallCandidate,
  channel: RecallChannel,
  score: number | null,
): void {
  if (score === null || !Number.isFinite(score)) return
  if (channel === 'semantic' && candidate.semanticScore === null) {
    candidate.semanticScore = score
    return
  }
  if (channel === 'wish' && candidate.wishScore === null) {
    candidate.wishScore = score
    return
  }
  if (channel === 'popular' && candidate.popularity === null) {
    candidate.popularity = score
  }
}

/**
 * 截断排序的比较器（导出供测试与 R4 复用）：
 * 跨通道命中数多者优先 → 最高优先级通道更靠前者优先 → listingId 升序兜底。
 *
 * 最后一条是**确定性的关键**：只按前两条排，同分候选的顺序会随 `Map` 插入顺序漂移，而插入顺序由
 * 各路的返回顺序决定（SQL 未显式 ORDER BY 时 PG 不保证稳定），M8 要求的"同输入可复现"就会破。
 */
export function compareRecallCandidates(a: RecallCandidate, b: RecallCandidate): number {
  if (a.recallSources.length !== b.recallSources.length) {
    return b.recallSources.length - a.recallSources.length
  }
  const aPriority = Math.min(...a.recallSources.map(channelPriority))
  const bPriority = Math.min(...b.recallSources.map(channelPriority))
  if (aPriority !== bPriority) return aPriority - bPriority
  if (a.listingId === b.listingId) return 0
  return a.listingId < b.listingId ? -1 : 1
}

/** 去重合并多路候选，并按 `maxCandidates` 截断（默认 `RECALL_MAX_CANDIDATES`）。 */
export function mergeRecallCandidates(input: MergeRecallCandidatesInput): RecallCandidate[] {
  const maxCandidates = input.maxCandidates ?? RECALL_MAX_CANDIDATES
  const visibleById = new Map(input.visible.map((listing) => [listing.listingId, listing]))
  const merged = new Map<string, RecallCandidate>()

  // 按通道优先级遍历：`recallSources` 天然按优先级有序，`applyChannelFeature` 先到先得也才有意义。
  const channels = [...input.channels].sort(
    (a, b) => channelPriority(a.channel) - channelPriority(b.channel),
  )

  for (const channel of channels) {
    for (const raw of channel.candidates) {
      const listing = visibleById.get(raw.listingId)
      if (listing === undefined) continue

      const existing = merged.get(raw.listingId)
      if (existing !== undefined) {
        if (existing.recallSources.length < RECALL_MAX_SOURCES_PER_CANDIDATE) {
          existing.recallSources.push(channel.channel)
        }
        applyChannelFeature(existing, channel.channel, raw.score)
        continue
      }

      const candidate: RecallCandidate = {
        listingId: listing.listingId,
        sellerId: listing.sellerId,
        category: listing.category,
        recallSources: [channel.channel],
        semanticScore: null,
        wishScore: null,
        popularity: null,
        userCategoryAffinity: input.categoryAffinity.get(listing.category) ?? null,
        freshness: freshnessOf(listing.createdAt, input.now),
        createdAt: listing.createdAt,
        alreadySeenCount: input.impressions.get(raw.listingId) ?? 0,
        sellerExposure: 0,
      }
      applyChannelFeature(candidate, channel.channel, raw.score)
      merged.set(raw.listingId, candidate)
    }
  }

  const sellerCounts = new Map<string, number>()
  for (const candidate of merged.values()) {
    sellerCounts.set(candidate.sellerId, (sellerCounts.get(candidate.sellerId) ?? 0) + 1)
  }
  for (const candidate of merged.values()) {
    candidate.sellerExposure = sellerCounts.get(candidate.sellerId) ?? 0
  }

  return [...merged.values()].sort(compareRecallCandidates).slice(0, maxCandidates)
}
