import { LISTING_ROUTES } from '@fish/contracts/listings/routes'
import {
  type ListingFeedResponse,
  ListingFeedResponseSchema,
} from '@fish/contracts/listings/schema'
import { apiRequest } from '../../lib/api-client'

/** PC 首页第一页：契约 limit 上限 50，网格按 4 列取 24 条。 */
export async function fetchHomeFeed(): Promise<ListingFeedResponse> {
  const payload = await apiRequest(`${LISTING_ROUTES.base}?limit=24&sort=newest`)
  return ListingFeedResponseSchema.parse(payload)
}
