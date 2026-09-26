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
  sort: ListingSort
  limit?: number
  cursor?: string
}

/** 只拼公开 Feed 的查询参数；cursor 由服务端下发，前端不解析。 */
export function listingFeedPath(query: PcListingFeedQuery): string {
  const params = new URLSearchParams()
  if (query.q !== undefined) params.set('q', query.q)
  if (query.category !== undefined) params.set('category', query.category)
  params.set('sort', query.sort)
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  if (query.cursor !== undefined) params.set('cursor', query.cursor)
  return `${LISTING_ROUTES.base}?${params.toString()}`
}

export async function fetchListingFeed(query: PcListingFeedQuery): Promise<ListingFeedResponse> {
  const payload = await apiRequest(listingFeedPath(query))
  return ListingFeedResponseSchema.parse(payload)
}

/** PC 首页第一页：契约 limit 上限 50，网格按 4 列取 24 条。 */
export async function fetchHomeFeed(): Promise<ListingFeedResponse> {
  return fetchListingFeed({ limit: 24, sort: 'newest' })
}
