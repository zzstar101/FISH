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
  type ListingCreateInput,
  type ListingDetail,
  ListingDetailSchema,
  type ListingFeedResponse,
  ListingFeedResponseSchema,
  type ListingSort,
  type ListingUpdateInput,
} from '@fish/contracts/listings/schema'
import { apiRequest, isApiError } from '@/lib/request'

/**
 * feed 单页上限。契约 `ListingFeedQuerySchema` 的 `limit` 上限是 50，
 * 超了会被 422 拒掉，所以这里写死 50 并在分页时靠 `cursor` 续。
 */
const PAGE_SIZE = 50

/**「我的发布」最多翻的页数（5 × 50 = 250 件）；防 cursor 异常时无限循环。 */
const MY_LISTINGS_MAX_PAGES = 5

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

/** 按分类取商品（首页的分类筛选），可指定排序（契约只支持 newest / priceAsc / priceDesc） */
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

/**
 * 发布商品（写路径）。
 *
 * 非 2xx 一律抛 `ApiError`，调用方据 `code` 分支：`LISTING_CONTENT_BLOCKED` 的
 * `details[{field,message}]` 指明是标题还是描述该改（#74）。
 *
 * 成功响应仍用契约 schema 收口。`REVIEW` 时商品是 `OFFLINE` 且不公开，但
 * `isOwner` 为 true、`moderationStatus === 'REVIEW'` —— 发布页据此显示「已提交审核」
 * 而不是「已公开」。
 */
export async function createListing(input: ListingCreateInput): Promise<ListingDetail> {
  const payload = await apiRequest(LISTING_ROUTES.base, { method: 'POST', body: input })
  return ListingDetailSchema.parse(payload)
}

/**
 * 编辑商品。`objectKeys` 省略 = **保持原图**：详情响应刻意不给 `objectKey`（存储布局不进
 * 读协议），前端没有全量替换所需的输入，所以编辑态图片只读（与 Web 端同一取舍）。
 */
export async function updateListing(id: string, input: ListingUpdateInput): Promise<ListingDetail> {
  const payload = await apiRequest(LISTING_ROUTES.detail(id), { method: 'PATCH', body: input })
  return ListingDetailSchema.parse(payload)
}

/**
 * 「我的发布」：本人视角的**全部状态**商品（含审核中的），按最新排序翻页拉齐。
 *
 * 必须传 `sellerId` 本人：契约只有在 `sellerId === viewerId` 时才把 `status` 过滤打开、
 * 并返回真实的 `moderationStatus`（服务端 `listFeed` 的 `includeUnapproved`）。
 * 单页上限 50（契约 `limit` 上限），翻页靠不透明 cursor；封顶 5 页（250 件）防异常死循环。
 */
export async function fetchMyListings(sellerId: string): Promise<ListingCard[]> {
  const items: ListingCard[] = []
  let cursor: string | undefined
  for (let page = 0; page < MY_LISTINGS_MAX_PAGES; page += 1) {
    const payload = await apiRequest(LISTING_ROUTES.base, {
      query: { sellerId, sort: 'newest', limit: PAGE_SIZE, cursor },
    })
    const parsed = ListingFeedResponseSchema.parse(payload)
    items.push(...parsed.items)
    if (parsed.nextCursor === null) break
    cursor = parsed.nextCursor
  }
  return items
}

/**
 * 下架：`ACTIVE → OFFLINE`；对已 OFFLINE 幂等（契约 §2.5），返回最新详情。
 * 审核中的商品不在本页给这个入口（它是 REVIEW，不是「在售」）。
 */
export async function offlineListing(id: string): Promise<ListingDetail> {
  const payload = await apiRequest(LISTING_ROUTES.offline(id), { method: 'POST' })
  return ListingDetailSchema.parse(payload)
}

/** 重新上架：`OFFLINE → ACTIVE`；对已 ACTIVE 幂等。REVIEW / BLOCKED 会被服务端拒绝（409）。 */
export async function onlineListing(id: string): Promise<ListingDetail> {
  const payload = await apiRequest(LISTING_ROUTES.online(id), { method: 'POST' })
  return ListingDetailSchema.parse(payload)
}
