/**
 * 商品域 API（首页 feed / 分类 / 搜索 / 详情）。
 *
 * 路径一律取自契约常量（`@fish/contracts/listings/routes`），不硬编码字符串；
 * 响应一律用契约 schema 收口，形状漂移在解析处就炸，而不是渲染到页面上才炸。
 */
import { LISTING_ROUTES } from '@fish/contracts/listings/routes'
import {
  type ListingCard,
  type ListingCategory,
  type ListingDetail,
  ListingDetailSchema,
  type ListingFeedResponse,
  ListingFeedResponseSchema,
  type ListingSort,
} from '@fish/contracts/listings/schema'
import { apiRequest, isApiError } from '@/lib/request'

/**
 * feed 单页上限。契约 `ListingFeedQuerySchema` 的 `limit` 上限是 50，
 * 超了会被 422 拒掉，所以这里写死 50 并在分页时靠 `cursor` 续。
 */
const PAGE_SIZE = 50

type FeedArgs = {
  category?: ListingCategory
  keyword?: string
  sort?: ListingSort
  /** 只取免费（0 元送）：首页快捷入口用 */
  freeOnly?: boolean
  priceMinCents?: number
  priceMaxCents?: number
  cursor?: string
}

/** 拉一页 feed。`cursor` 是不透明串，只能原样回传上一页的 `nextCursor`（契约禁止前端解析）。 */
export async function fetchFeed(args: FeedArgs = {}): Promise<ListingFeedResponse> {
  const payload = await apiRequest(LISTING_ROUTES.base, {
    query: {
      q: args.keyword,
      category: args.category,
      sort: args.sort ?? 'newest',
      limit: PAGE_SIZE,
      cursor: args.cursor,
      priceMinCents: args.freeOnly ? 0 : args.priceMinCents,
      priceMaxCents: args.freeOnly ? 0 : args.priceMaxCents,
    },
  })
  return ListingFeedResponseSchema.parse(payload)
}

/** 首页瀑布流：取最新一页（不做无限滚动，与设计稿一致） */
export async function fetchHomeFeed(): Promise<ListingCard[]> {
  const page = await fetchFeed({ sort: 'newest' })
  return page.items
}

/** 分类页：按分类取商品，可指定排序（契约只支持 newest / priceAsc / priceDesc） */
export async function fetchCategoryListings(
  category: ListingCategory,
  sort: ListingSort = 'newest',
): Promise<ListingCard[]> {
  const page = await fetchFeed({ category, sort })
  return page.items
}

/** 搜索页 */
export async function searchListings(keyword: string, sort: ListingSort): Promise<ListingCard[]> {
  const page = await fetchFeed({ keyword, sort })
  return page.items
}

/**
 * 商品详情。
 *
 * 404 返回 `null` 而不是抛错：详情页对「商品不存在」有专门的空态，
 * 让调用方用一个 `if (detail === null)` 处理，不必去分辨 ApiError 的 code。
 */
export async function fetchListingDetail(id: string): Promise<ListingDetail | null> {
  try {
    const payload = await apiRequest(LISTING_ROUTES.detail(id))
    return ListingDetailSchema.parse(payload)
  } catch (error) {
    if (isApiError(error) && error.status === 404) return null
    throw error
  }
}

/** 同类推荐：契约没有专门的相似接口，按分类取一页再排掉自己（与 Web 端同做法） */
export async function fetchSimilarListings(
  category: ListingCategory,
  excludeId: string,
  limit = 4,
): Promise<ListingCard[]> {
  const page = await fetchFeed({ category })
  return page.items.filter((item) => item.id !== excludeId).slice(0, limit)
}
