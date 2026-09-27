import {
  type ListingMatchListResponse,
  ListingMatchListResponseSchema,
  type MatchingErrorCode,
  type WishMatchListResponse,
  WishMatchListResponseSchema,
} from '@fish/contracts/matching/schema'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { toListingCard } from '../listings/card'
import type { MediaStorage } from '../uploads/storage'
import type { MatchingStore } from './store'

/**
 * 匹配读接口的业务层（Issue #8 契约评论 §2）。
 *
 * 两件事：**归属校验**（谁有权看谁的匹配）与**读模型映射**（行 → 契约 DTO）。
 * 分数与排序全部来自 SQL（`store.ts`），这里不做过滤或重排。
 *
 * 403 / 404 的区分（契约 §4）：目标存在但不是本人的 → 403；目标不存在 → 404。
 * 这与 #6 的 `sellerId` 传他人返 403、#7 的读他人愿望返 403 一致（`wishes/service.ts:107`）。
 */
export class MatchingServiceError extends Error {
  constructor(
    readonly status: 403 | 404,
    readonly code: MatchingErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'MatchingServiceError'
  }
}

export interface MatchingService {
  listByWish(userId: string, wishId: string, limit: number): Promise<WishMatchListResponse>
  listByListing(userId: string, listingId: string, limit: number): Promise<ListingMatchListResponse>
}

export function createMatchingService(deps: {
  store: MatchingStore
  storage: Pick<MediaStorage, 'publicUrl'>
}): MatchingService {
  const { store, storage } = deps

  const notFound = () => new MatchingServiceError(404, 'MATCH_TARGET_NOT_FOUND', '目标不存在')
  const notOwner = () => new MatchingServiceError(403, 'NOT_TARGET_OWNER', '无权查看该目标的匹配')

  return {
    async listByWish(userId, wishId, limit) {
      const wish = await store.findWish(wishId)
      if (!wish) throw notFound()
      if (wish.ownerId !== userId) throw notOwner()

      const [total, entries] = await Promise.all([
        store.countWishMatches(wishId),
        store.listWishMatches(wishId, limit),
      ])

      // 无法映射为契约的卡片按 #6 的决定 C 跳过（不 500）；`total` 仍是库里的真实条数，
      // 所以 `items.length` 可能小于 `total`，前端不该拿它们互相推导。
      const items = entries.flatMap((entry) => {
        const listing = toListingCard(entry.listing, entry.coverObjectKey, storage)
        if (!listing) return []
        return [
          {
            id: encodePublicId(PUBLIC_ID_PREFIX.match, entry.matchId),
            score: entry.score,
            createdAt: entry.createdAt.toISOString(),
            listing,
          },
        ]
      })

      return WishMatchListResponseSchema.parse({ total, items })
    },

    async listByListing(userId, listingId, limit) {
      const listing = await store.findListing(listingId)
      if (!listing) throw notFound()
      if (listing.ownerId !== userId) {
        // #6 的取向：`OFFLINE` 商品对非卖家返 404 而不是 403 —— 403 等于确认"这个 id 存在
        // 且是别人的商品"（`apps/api/src/modules/listings/service.ts:192-193`）。这里保持一致，
        // 否则 `/matches?listingId=` 就成了"他人离线商品 id"的存在性探测器。
        if (listing.status === 'OFFLINE') throw notFound()
        throw notOwner()
      }

      const [total, entries] = await Promise.all([
        store.countListingMatches(listingId),
        store.listListingMatches(listingId, limit),
      ])

      return ListingMatchListResponseSchema.parse({
        total,
        items: entries.map((entry) => ({
          id: encodePublicId(PUBLIC_ID_PREFIX.match, entry.matchId),
          score: entry.score,
          createdAt: entry.createdAt.toISOString(),
          wish: { ...entry.wish, id: encodePublicId(PUBLIC_ID_PREFIX.wish, entry.wish.id) },
        })),
      })
    },
  }
}
