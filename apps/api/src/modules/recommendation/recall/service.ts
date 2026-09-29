/**
 * R3 多路召回编排（Issue #323 M2/M3）。
 *
 * 本模块是 recall 层的**唯一对外入口**：算兴趣向量 → 并发/顺序跑六路 → 合并去重 →
 * 最终可见性复核 → 返回候选集。三条硬约束决定了它的形状：
 *
 * 1. **整层不抛错**（Issue #323 M2："vector retrieval 失败不能让首页 500"）。每一路各自
 *    try/catch，失败只降级成空候选 + 结构化原因；本函数的返回类型里没有异常路径。
 * 2. **单路失败不影响别路**：因此每路单独 await（不 `Promise.all` 成一锅）——一路抛错时
 *    `Promise.all` 会连别的通道的结果一起丢掉，而"semantic 挂了还有 fresh/popular/category/wish/
 *    explore 兜底"正是 M2 要求的能力。
 * 3. **可见性真值来自最终复核**：合并层只认 `findVisibleListingRefs` 的结果；这次查询失败时
 *    宁可返回空候选也不返回未经复核的候选（M3："不依赖召回时快照作为最终可见性真值"）。
 *
 * **本服务在 R3 没有生产调用方**：R1 的 Feed 仍是 `newest` 透传，`startFeed` 接召回是 R4/R5 的事。
 * 因此 `apps/api/src/app.ts` 本轮不改——不为了"能被调用"而提前接线一个尚未消费的候选集。
 */

import type { ListingCategory } from '@fish/contracts/listings/schema'
import { ListingCategorySchema } from '@fish/contracts/listings/schema'
import {
  INTEREST_ACTION_WEIGHTS,
  INTEREST_HALF_LIFE_MS,
  INTEREST_SESSION_MAX_ACTIONS,
  INTEREST_STRATEGY_VERSION,
  INTEREST_ZERO_WEIGHT_EVENT_TYPES,
  interestLookbackStart,
} from '@fish/contracts/recommendation/interest'
import type { RecallChannel } from '@fish/contracts/recommendation/recall'
import {
  combineInterestVectors,
  POPULARITY_ACTION_HALF_LIFE_MS,
  POPULARITY_ACTION_TYPES,
  POPULARITY_ACTION_WEIGHTS,
  POPULARITY_LISTING_AGE_HALF_LIFE_MS,
  popularityWindowStart,
  RECALL_CHANNEL_LIMITS,
  RECALL_EXPLORE_MIX,
  RECALL_EXPLORE_NEW_LISTING_WINDOW_MS,
  RECALL_EXPLORE_NEW_SELLER_WINDOW_MS,
  RECALL_SESSION_CATEGORY_TOP_N,
  RECALL_STRATEGY_VERSION,
} from '@fish/contracts/recommendation/recall'
import { RecommendationEventTypeSchema } from '@fish/contracts/recommendation/schema'
import type { Db } from '@fish/db/client'
import {
  countListingImpressions,
  findCategoryRecallCandidates,
  findExploreRecallCandidates,
  findFreshRecallCandidates,
  findPopularRecallCandidates,
  findSemanticRecallCandidates,
  findSessionCategoryWeights,
  findVisibleListingRefs,
  findWishRecallCandidates,
  type SessionCategoryWeight,
} from '@fish/db/recall-store'
import { findUserInterestProfile, type InterestIdentity } from '@fish/db/user-interest-store'
import { readSessionInterest } from '../interest'
import { mergeRecallCandidates } from './merge'
import type {
  ChannelCandidate,
  ChannelRecall,
  RecallCandidate,
  RecallChannelOutcome,
  RecallDegradeReason,
  RecallResult,
} from './types'

export type RecommendationRecallInput = {
  /** 已登录用户（token 真值）。 */
  userId: string | null
  /** 匿名会话 id（客户端自述，仅用于把同一会话的行为串起来）。 */
  anonymousSessionId: string | null
}

export type RecommendationRecallDeps = {
  db: Db
  /**
   * 当前 embedding 模型真值（`loadRecommendationEmbeddingModel()` 的产出）。
   *
   * `null` = 装配处拿不到模型配置。生产装配是启动期 fail-fast，所以线上不该出现 null；
   * 保留这个分支是为了让"模型不可用 → semantic 降级、其余通道照常"这条路径可测，
   * 也让本模块不必 import env。
   */
  embeddingModel: string | null
  clock?: () => Date
}

export interface RecommendationRecall {
  recall(input: RecommendationRecallInput): Promise<RecallResult>
}

function resolveIdentity(input: RecommendationRecallInput): InterestIdentity | null {
  if (input.userId !== null) return { kind: 'user', id: input.userId }
  if (input.anonymousSessionId !== null) return { kind: 'anonymous', id: input.anonymousSessionId }
  return null
}

/** 跑一路，失败即降级（不抛）。 */
async function runChannel(
  channel: RecallChannel,
  run: () => Promise<ChannelCandidate[]>,
): Promise<ChannelRecall> {
  try {
    return { channel, candidates: await run(), degradedReason: null }
  } catch (error) {
    console.warn(`[recommendation] 召回通道 ${channel} 失败，按空候选降级：`, error)
    return { channel, candidates: [], degradedReason: 'provider_error' }
  }
}

/** 会话类目权重 → `{channel 候选顺序, 亲和控制}`。 */
function rankSessionCategories(weights: readonly SessionCategoryWeight[]): {
  ranking: SessionCategoryWeight[]
  affinity: Map<ListingCategory, number>
} {
  const seen = new Map<ListingCategory, number>()
  const positive = weights
    .filter((row) => row.weight > 0)
    .sort((a, b) => {
      if (a.weight !== b.weight) return b.weight - a.weight
      // 同权重按类目名兜底，否则顺序取决于 SQL 返回顺序（M8 要求同输入可复现）。
      return a.category < b.category ? -1 : a.category > b.category ? 1 : 0
    })

  const max = positive[0]?.weight ?? 0
  for (const row of positive) seen.set(row.category, row.weight / max)

  return { ranking: positive.slice(0, RECALL_SESSION_CATEGORY_TOP_N), affinity: seen }
}

export function createRecommendationRecall(deps: RecommendationRecallDeps): RecommendationRecall {
  return {
    async recall(input) {
      const now = deps.clock?.() ?? new Date()
      const viewerUserId = input.userId
      const identity = resolveIdentity(input)
      const model = deps.embeddingModel

      /**
       * 降级原因分开记账：`no_profile` 是"这个人现在没有画像"（正常冷启动），`model_unavailable`
       * 是"这个部署拿不到模型"（配置问题），混成一个原因会让监控无法区分。
       */
      const identityReason: RecallDegradeReason | null = identity === null ? 'no_profile' : null

      let sessionVector: number[] | null = null
      let longTermVector: number[] | null = null
      let sessionCategoryRows: SessionCategoryWeight[] = []
      let interestReason: RecallDegradeReason | null =
        identityReason ?? (model === null ? 'model_unavailable' : null)
      let categoryReason: RecallDegradeReason | null = identityReason

      // 会话类目权重是**纯 SQL**（不碰向量），所以只依赖身份、不依赖 embedding 模型：
      // category 是 semantic 不可用时的兜底通道（设计文档 §2 决定 1 / Issue M2），把它一起锁在
      // `model !== null` 后面会让"模型不可用"退化成"个性化全丢"。
      if (identity !== null) {
        try {
          sessionCategoryRows = await findSessionCategoryWeights(deps.db, {
            identity,
            since: interestLookbackStart(now),
            now,
            limit: INTEREST_SESSION_MAX_ACTIONS,
            zeroWeightEventTypes: INTEREST_ZERO_WEIGHT_EVENT_TYPES,
            // **R2 的兴趣权重表**，不是 Popular 的热度表：会话类目兴趣描述的是"这个用户想看什么"
            // （HIDE/QUICK_SKIP 是负向证据），而 Popular 描述的是"全站最近在火什么"。
            weights: RecommendationEventTypeSchema.options.map((eventType) => ({
              eventType,
              weight: INTEREST_ACTION_WEIGHTS[eventType],
            })),
            halfLifeMs: INTEREST_HALF_LIFE_MS.session,
          })
        } catch (error) {
          console.warn('[recommendation] 会话类目权重聚合失败，category 通道将降级：', error)
          categoryReason = 'provider_error'
        }
      }

      // session 向量与长期画像都需要模型（前者要与商品向量比相似度，后者是按模型维度物化的缓存），
      // 因此这两样锁在 `model !== null` 后面；category 通道不受此影响。
      if (identity !== null && model !== null) {
        try {
          const session = await readSessionInterest(deps.db, { identity, model, now })
          sessionVector = session.vector
        } catch (error) {
          console.warn('[recommendation] session 画像聚合失败，semantic 通道将降级：', error)
          interestReason = 'provider_error'
        }

        if (identity.kind === 'user') {
          try {
            const profile = await findUserInterestProfile(deps.db, {
              userId: identity.id,
              model,
            })
            // R2 交接：`strategy_version` 只写不读，读取方（本模块）必须校验版本。
            // 旧版本的行是"上一版权重算出来的方向"，拿它当现行画像会让版本升级静默失效。
            longTermVector =
              profile !== null && profile.strategyVersion === INTEREST_STRATEGY_VERSION
                ? profile.embedding
                : null
          } catch (error) {
            // 读取失败**不是**"这个用户没有画像"：报告原因必须与"真·无画像"区分开，否则
            // R6 的通道分账会把一次数据库故障统计成冷启动。session 向量若可用，semantic 照常跑，
            // `interestReason` 只在最终没有合成向量时才被当作降级原因。
            console.warn('[recommendation] 长期画像读取失败，semantic 通道将只用 session：', error)
            interestReason = 'provider_error'
          }
        }
      }

      let combined: number[] | null = null
      try {
        combined = combineInterestVectors({ session: sessionVector, longTerm: longTermVector })
      } catch (error) {
        console.warn(
          '[recommendation] 兴趣合成失败（两路维度不一致？），semantic 通道将降级：',
          error,
        )
        interestReason = 'provider_error'
      }

      const { ranking: categoryRanking, affinity: categoryAffinity } =
        rankSessionCategories(sessionCategoryRows)

      const channels: ChannelRecall[] = []

      channels.push(
        await runChannel('fresh', async () => {
          const rows = await findFreshRecallCandidates(deps.db, {
            limit: RECALL_CHANNEL_LIMITS.fresh,
            viewerUserId,
          })
          return rows.map((row) => ({ listingId: row.listingId, score: null }))
        }),
      )

      channels.push(
        await runChannel('popular', async () => {
          const rows = await findPopularRecallCandidates(deps.db, {
            limit: RECALL_CHANNEL_LIMITS.popular,
            viewerUserId,
            windowStart: popularityWindowStart(now),
            now,
            weights: POPULARITY_ACTION_TYPES.map((eventType) => ({
              eventType,
              weight: POPULARITY_ACTION_WEIGHTS[eventType],
            })),
            actionHalfLifeMs: POPULARITY_ACTION_HALF_LIFE_MS,
            listingAgeHalfLifeMs: POPULARITY_LISTING_AGE_HALF_LIFE_MS,
          })
          return rows.map((row) => ({ listingId: row.listingId, score: row.popularity }))
        }),
      )

      if (combined === null || model === null) {
        channels.push({
          channel: 'semantic',
          candidates: [],
          degradedReason: interestReason ?? 'no_profile',
        })
      } else {
        const interestVector = combined
        channels.push(
          await runChannel('semantic', async () => {
            const rows = await findSemanticRecallCandidates(deps.db, {
              vector: interestVector,
              model,
              limit: RECALL_CHANNEL_LIMITS.semantic,
              viewerUserId,
            })
            return rows.map((row) => ({ listingId: row.listingId, score: row.semanticScore }))
          }),
        )
      }

      if (viewerUserId === null) {
        // 愿望属于登录用户；匿名会话没有愿望可匹配，这是"该路本身空"，不是故障。
        channels.push({ channel: 'wish', candidates: [], degradedReason: 'no_profile' })
      } else {
        const wishUserId = viewerUserId
        channels.push(
          await runChannel('wish', async () => {
            const rows = await findWishRecallCandidates(deps.db, {
              userId: wishUserId,
              limit: RECALL_CHANNEL_LIMITS.wish,
            })
            return rows.map((row) => ({ listingId: row.listingId, score: row.wishScore }))
          }),
        )
      }

      if (categoryRanking.length === 0) {
        channels.push({
          channel: 'category',
          candidates: [],
          degradedReason: categoryReason ?? 'no_profile',
        })
      } else {
        const perCategoryLimit = Math.max(
          1,
          Math.ceil(RECALL_CHANNEL_LIMITS.category / categoryRanking.length),
        )
        channels.push(
          await runChannel('category', async () => {
            const rows = await findCategoryRecallCandidates(deps.db, {
              categories: categoryRanking.map((row) => row.category),
              perCategoryLimit,
              viewerUserId,
            })
            // 每个类目各自 limit，合计可能略超通道配额（`ceil`），在通道边界上截断。
            return rows
              .slice(0, RECALL_CHANNEL_LIMITS.category)
              .map((row) => ({ listingId: row.listingId, score: null }))
          }),
        )
      }

      // 冷门类目 = 会话行为窗里**没出现过**的类目（不区分权重正负：用户看过但明确不喜欢的类目
      // 不算"没接触过"）。窗口聚合失败时退化为"全部类目都算冷门"——探索通道因此仍能出候选，
      // 但探索的定向性下降，这一点由 `categoryReason` 在通道对账里体现。
      const seenCategories = new Set(sessionCategoryRows.map((row) => row.category))
      const coldCategories = ListingCategorySchema.options.filter(
        (category) => !seenCategories.has(category),
      )
      channels.push(
        await runChannel('explore', async () => {
          const rows = await findExploreRecallCandidates(deps.db, {
            limit: RECALL_CHANNEL_LIMITS.explore,
            newListingLimit: RECALL_EXPLORE_MIX.newListing,
            newSellerLimit: RECALL_EXPLORE_MIX.newSeller,
            coldCategoryLimit: RECALL_EXPLORE_MIX.coldCategory,
            newListingWindowStart: new Date(now.getTime() - RECALL_EXPLORE_NEW_LISTING_WINDOW_MS),
            newSellerWindowStart: new Date(now.getTime() - RECALL_EXPLORE_NEW_SELLER_WINDOW_MS),
            coldCategories,
            viewerUserId,
          })
          return rows.map((row) => ({ listingId: row.listingId, score: null }))
        }),
      )

      const listingIds = [
        ...new Set(channels.flatMap((channel) => channel.candidates.map((row) => row.listingId))),
      ]

      let mergeDegradedReason: RecallDegradeReason | null = null
      let visibilityFailed = false
      let visible: Awaited<ReturnType<typeof findVisibleListingRefs>> = []
      if (listingIds.length > 0) {
        try {
          visible = await findVisibleListingRefs(deps.db, { listingIds, viewerUserId })
        } catch (error) {
          // 复核失败 = 拿不到"此刻可见"的真值。宁可整层返回空候选，也不把未经复核的候选交出去。
          console.warn('[recommendation] 最终可见性复核失败，本次召回返回空候选：', error)
          mergeDegradedReason = 'provider_error'
          visibilityFailed = true
        }
      }

      const impressions = new Map<string, number>()
      if (identity !== null && listingIds.length > 0 && !visibilityFailed) {
        try {
          const rows = await countListingImpressions(deps.db, { listingIds, identity })
          for (const row of rows) impressions.set(row.listingId, row.count)
        } catch (error) {
          // 曝光计数失败只损失 `alreadySeenCount`（R3 无消费方），不改变可见性，因此不清空候选。
          console.warn('[recommendation] 曝光次数读取失败，alreadySeenCount 记为 0：', error)
          mergeDegradedReason = 'provider_error'
        }
      }

      let candidates: RecallCandidate[] = []
      if (!visibilityFailed) {
        try {
          candidates = mergeRecallCandidates({
            channels,
            visible,
            impressions,
            categoryAffinity,
            now,
          })
        } catch (error) {
          // 合并层是纯函数、本不该抛；但 M2 的"整层任何情况不抛"不能建立在"它不会抛"的假设上——
          // 否则 merge 里将来任何一处改动都会把首页变成 500。
          console.warn('[recommendation] 候选合并失败，本次召回返回空候选：', error)
          mergeDegradedReason = 'provider_error'
        }
      }

      const channelOutcomes: RecallChannelOutcome[] = channels.map((channel) => ({
        channel: channel.channel,
        candidateCount: channel.candidates.length,
        degradedReason: channel.degradedReason,
      }))

      return {
        strategyVersion: RECALL_STRATEGY_VERSION,
        candidates,
        channels: channelOutcomes,
        interest: {
          session: sessionVector !== null,
          longTerm: longTermVector !== null,
          combined: combined !== null,
        },
        mergeDegradedReason,
      }
    },
  }
}
