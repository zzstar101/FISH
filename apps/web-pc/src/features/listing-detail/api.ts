import { LISTING_ROUTES } from '@fish/contracts/listings/routes'
import { type ListingDetail, ListingDetailSchema } from '@fish/contracts/listings/schema'
import { ApiError, apiRequest } from '../../lib/api-client'

/**
 * 详情接口把「不存在、已下架但非卖家、非法 id」统一收敛成 404。
 * 页面用 null 表达「找不到或不可见」，避免把可预期的业务状态渲染成错误页。
 */
export async function fetchListingDetail(id: string): Promise<ListingDetail | null> {
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
