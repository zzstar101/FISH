/**
 * 匹配域契约 → 许愿页 / 匹配结果页视图的投影。
 *
 * `WishMatchItem` = `MatchBase` + `listing: ListingCard`（契约冻结，见
 * `packages/contracts/src/matching/schema.ts`）。#191 起契约卡片内嵌 `seller`
 * （公开四字段），`toMockListing` 已把它投影进 `MockListing.seller`；
 * `MatchView.seller` 直接取自卡片，不再逐条拉详情补齐。
 */
import type { WishMatchItem } from '@fish/contracts/matching/schema'
import { toMockListing } from '@/features/listing/adapt'
import type { MockListing, MockMatch } from '@/mock/types'

/** 一条命中：许愿页卡内嵌的「愿望成真」列表只需要「匹配 + 商品」两项 */
export type WishHit = {
  match: MockMatch
  listing: MockListing
}

/** 匹配结果页的一行：命中 + 商品 + 卖家（卖家可能补不到，见文件头） */
export type MatchView = WishHit & { seller: MockListing['seller'] }

/** 把一条契约匹配投影成页面视图；`wishId` 由查询上下文补上（响应里没有）。 */
export function toWishHit(item: WishMatchItem, wishId: string): WishHit {
  return {
    match: { id: item.id, wishId, listingId: item.listing.id, score: item.score },
    listing: toMockListing(item.listing),
  }
}
