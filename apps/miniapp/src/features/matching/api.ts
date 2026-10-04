/**
 * 匹配域 API（`GET /matches`，契约见 `@fish/contracts/matching`）。
 *
 * 「谁在求购」（`byListing`）是**卖家看自己商品**的读路径：整挂 `requireAuth`，
 * 且归属校验在服务端（非本人 403 `NOT_TARGET_OWNER`）—— 端上不必、也不该传用户 id。
 *
 * ⚠️ `byListing` / `byWish` 这两个路径常量**自带 query 串**（`/matches?listingId=…`），
 * 而 `lib/request` 的 `buildQuery` 会无条件再拼一个 `?` —— 所以这两个端点**不能**再传
 * `query` 参数（会拼出 `?listingId=…?limit=10`）。`limit` 走服务端默认档 10，
 * 「谁在求购」的量级是个位数到几十，够用；要改上限时用 `&` 手工续在常量后面。
 */

import { MATCHING_ROUTES } from '@fish/contracts/matching/routes'
import {
  type ListingMatchListResponse,
  ListingMatchListResponseSchema,
} from '@fish/contracts/matching/schema'
import { apiRequest } from '@/lib/request'

/** 我的一件商品的匹配愿望列表（谁在求购）。非本人调用 403。 */
export async function fetchListingMatches(listingId: string): Promise<ListingMatchListResponse> {
  const payload = await apiRequest(MATCHING_ROUTES.byListing(listingId))
  return ListingMatchListResponseSchema.parse(payload)
}
