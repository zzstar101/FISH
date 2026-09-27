import { LISTING_ROUTES } from '@fish/contracts/listings/routes'
import type {
  ListingCard,
  ListingCategory,
  ListingCondition,
  ListingSort,
} from '@fish/contracts/listings/schema'
import {
  type ListingDetail,
  ListingDetailSchema,
  ListingFeedResponseSchema,
  ListingNumberLookupResponseSchema,
  type ListingUpdateInput,
} from '@fish/contracts/listings/schema'
import { ApiError, apiRequest } from '../../lib/api-client'

function readCards(payload: unknown): { items: ListingCard[]; nextCursor: string | null } {
  return ListingFeedResponseSchema.parse(payload)
}

function readDetail(payload: unknown): ListingDetail {
  return ListingDetailSchema.parse(payload)
}

/**
 * 商品 feed / 搜索 / 分类共用的列表读。P0 取第一页（limit 上限 50）；
 * feed 游标由契约保留，无限滚动（#4 后续）需要时再接。
 */
async function fetchFeedPage(query: Record<string, string>): Promise<ListingCard[]> {
  const params = new URLSearchParams({ ...query, limit: '50' })
  return readCards(await apiRequest(`${LISTING_ROUTES.base}?${params.toString()}`)).items
}

/** 首页瀑布流：只含 ACTIVE（服务端默认口径），newest 排序。 */
export function fetchFeed(): Promise<ListingCard[]> {
  return fetchFeedPage({})
}

export function fetchCategoryListings(category: ListingCategory): Promise<ListingCard[]> {
  return fetchFeedPage({ category })
}

export function searchListings(q: string, sort: ListingSort): Promise<ListingCard[]> {
  return fetchFeedPage({ q, sort })
}

/** 精确编号仅 404 代表未命中；429/503 等错误必须传给页面，不回退关键词。 */
export async function findListingByNumber(listingNo: string): Promise<string | null> {
  try {
    const payload = await apiRequest(LISTING_ROUTES.byNumber(listingNo))
    return ListingNumberLookupResponseSchema.parse(payload).id
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
}

/** 「免费送」快捷入口：0 元商品没有文案可搜，契约的 priceMaxCents=0 就是它的筛选器。 */
export function fetchFreeListings(sort: ListingSort): Promise<ListingCard[]> {
  return fetchFeedPage({ priceMaxCents: '0', sort })
}

/** 详情。404（LISTING_NOT_FOUND / 不存在或 OFFLINE 非卖家）收敛为 null，由页面走「找不到商品」空态。 */
export async function fetchListingDetail(id: string): Promise<ListingDetail | null> {
  try {
    return readDetail(await apiRequest(LISTING_ROUTES.detail(id)))
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
}

/** 同类好物：同分类 feed 里去掉当前商品，最多 6 件。 */
export async function fetchSimilarListings(
  category: ListingCategory,
  excludeId: string,
): Promise<ListingCard[]> {
  const items = await fetchFeedPage({ category })
  return items.filter((item) => item.id !== excludeId).slice(0, 6)
}

export async function createListing(input: {
  title: string
  description: string
  priceCents: number
  category: ListingCategory
  condition: ListingCondition
  urgent: boolean
  negotiable: boolean
  free: boolean
  objectKeys: string[]
}): Promise<ListingDetail> {
  return readDetail(
    await apiRequest(LISTING_ROUTES.base, { method: 'POST', body: JSON.stringify(input) }),
  )
}

export async function updateListing(id: string, input: ListingUpdateInput): Promise<ListingDetail> {
  return readDetail(
    await apiRequest(LISTING_ROUTES.detail(id), { method: 'PATCH', body: JSON.stringify(input) }),
  )
}

/** 下架：ACTIVE → OFFLINE（幂等）。 */
export async function offlineListing(id: string): Promise<ListingDetail> {
  return readDetail(await apiRequest(LISTING_ROUTES.offline(id), { method: 'POST' }))
}

/** 重新上架：OFFLINE → ACTIVE（幂等）。 */
export async function onlineListing(id: string): Promise<ListingDetail> {
  return readDetail(await apiRequest(LISTING_ROUTES.online(id), { method: 'POST' }))
}
