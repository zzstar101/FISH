import { MATCHING_ROUTES } from '@fish/contracts/matching/routes'
import type { ListingMatchItem, WishMatchItem } from '@fish/contracts/matching/schema'
import {
  ListingMatchListResponseSchema,
  WishMatchListResponseSchema,
} from '@fish/contracts/matching/schema'
import { apiRequest } from '../../lib/api-client'

export type ListingMatchList = { total: number; items: ListingMatchItem[] }
export type WishMatchList = { total: number; items: WishMatchItem[] }

/** 商品方向：我的商品 → 想买它的愿望（匹配页）。 */
export async function fetchListingMatches(
  listingId: string,
  limit = 50,
): Promise<ListingMatchList> {
  return ListingMatchListResponseSchema.parse(
    await apiRequest(`${MATCHING_ROUTES.byListing(listingId)}&limit=${limit}`),
  )
}

/** 愿望方向：我的愿望 → 命中的在售商品（愿望成真卡片）。 */
export async function fetchWishMatches(wishId: string, limit = 50): Promise<WishMatchList> {
  return WishMatchListResponseSchema.parse(
    await apiRequest(`${MATCHING_ROUTES.byWish(wishId)}&limit=${limit}`),
  )
}
