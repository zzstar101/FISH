import { LISTING_ROUTES } from '@fish/contracts/listings/routes'
import {
  type ListingDetail,
  ListingDetailSchema,
  ListingIdSchema,
} from '@fish/contracts/listings/schema'
import { ApiError, apiRequest } from '../../lib/api-client'

/**
 * 详情接口的「不存在、已下架但非卖家」收敛成 404；非法公开 ID 在
 * 浏览器入口直接视为找不到，不向严格的 API 边界发送裸 UUID 或错误前缀。
 */
export async function fetchListingDetail(id: string): Promise<ListingDetail | null> {
  if (!ListingIdSchema.safeParse(id).success) return null
  try {
    const payload = await apiRequest(LISTING_ROUTES.detail(id))
    return ListingDetailSchema.parse(payload)
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && error.code === 'LISTING_NOT_FOUND') {
      return null
    }
    throw error
  }
}
