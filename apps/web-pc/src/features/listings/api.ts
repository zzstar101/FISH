import { LISTING_ROUTES } from '@fish/contracts/listings/routes'
import {
  type ListingCategory,
  type ListingFeedResponse,
  ListingFeedResponseSchema,
  type ListingSort,
} from '@fish/contracts/listings/schema'
import { apiRequest } from '../../lib/api-client'

export type PcListingFeedQuery = {
  q?: string
  category?: ListingCategory
  /** 「免费送」筛选（#451）。`undefined` 不传参数（不过滤）。 */
  free?: boolean
  sort: ListingSort
  limit?: number
  cursor?: string
}

/** 只拼公开 Feed 的查询参数；cursor 由服务端下发，前端不解析。 */
export function listingFeedPath(query: PcListingFeedQuery): string {
  const params = new URLSearchParams()
  if (query.q !== undefined) params.set('q', query.q)
  if (query.category !== undefined) params.set('category', query.category)
  // 契约只接受字面量 `true` / `false`（见 `ListingFeedQuerySchema` 的 `free`）：
  // 用 `String()` 而不是 `String(Boolean())` 之外的花样，避免拼出 `1` / `on` 这类被 422 拒的值。
  if (query.free !== undefined) params.set('free', String(query.free))
  params.set('sort', query.sort)
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  if (query.cursor !== undefined) params.set('cursor', query.cursor)
  return `${LISTING_ROUTES.base}?${params.toString()}`
}

export async function fetchListingFeed(query: PcListingFeedQuery): Promise<ListingFeedResponse> {
  const payload = await apiRequest(listingFeedPath(query))
  return ListingFeedResponseSchema.parse(payload)
}
