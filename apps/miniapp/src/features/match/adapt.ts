/**
 * 匹配域契约 → 许愿页 / 匹配结果页视图的投影。
 *
 * `WishMatchItem` = `MatchBase` + `listing: ListingCard`（契约冻结，见
 * `packages/contracts/src/matching/schema.ts`）。**ListingCard 里没有卖家**
 * （连 `sellerId` 都没有），所以 `MatchView.seller` 由调用方另行补齐
 * （匹配结果页逐条拉 `GET /listings/:id` 拿详情里的 seller）；补不到时是 `null`，
 * 页面据此不渲染卖家那一格 —— 不编造卖家（`features/listing/adapt.ts` 铁律 2）。
 */
import type { WishMatchItem } from '@fish/contracts/matching/schema'
import { toMockListing } from '@/features/listing/adapt'
import type { MockListing, MockMatch, MockUser } from '@/mock/types'

/** 一条命中：许愿页卡内嵌的「愿望成真」列表只需要「匹配 + 商品」两项 */
export type WishHit = {
  match: MockMatch
  listing: MockListing
}

/** 匹配结果页的一行：命中 + 商品 + 卖家（卖家可能补不到，见文件头） */
export type MatchView = WishHit & { seller: MockUser | null }

/** 把一条契约匹配投影成页面视图；`wishId` 由查询上下文补上（响应里没有）。 */
export function toWishHit(item: WishMatchItem, wishId: string): WishHit {
  return {
    match: { id: item.id, wishId, listingId: item.listing.id, score: item.score },
    listing: toMockListing(item.listing),
  }
}
