/**
 * 租赁域 API（#706 RNT-02）。
 *
 * 与 `features/listing/api.ts` 同一取舍：
 * - 路径一律取自契约常量（`@fish/contracts/rentals/routes`），不硬编码字符串；
 * - 响应一律用契约 schema 收口，形状漂移在解析处就炸。
 *
 * **为什么不复用商品域的 `fetchFeed`**：出租的列表语义不同（日租价、押金、可用租期），
 * 服务端是独立端点 `/rentals`，查询参数也不同（`days` 而不是 `free`）。
 */

import { RENTAL_ROUTES } from '@fish/contracts/rentals/routes'
import {
  type RentalCard,
  type RentalCreateInput,
  type RentalDetail,
  RentalDetailSchema,
  RentalFeedResponseSchema,
  type RentalSort,
  type RentalUpdateInput,
} from '@fish/contracts/rentals/schema'
import { apiRequest, isApiError } from '@/lib/request'

/** 广场单页上限。契约 `RentalFeedQuerySchema.limit` 上限是 50，超了会被 422 拒。 */
const PAGE_SIZE = 50

/** 广场最多翻的页数（5 × 50 = 250 件）；防 cursor 异常时无限循环。 */
const FEED_MAX_PAGES = 5

export type RentalFeedArgs = {
  keyword?: string
  sort?: RentalSort
  /** 只列出「能租满 N 天」的商品。 */
  days?: number
}

export type RentalFeedPage = {
  items: RentalCard[]
  /** 翻到页数上限时后面还有（与商品域 `truncated` 同一语义）。 */
  truncated: boolean
}

/**
 * 广场（公开）。按最新排序翻页拉齐，封顶 5 页。
 *
 * **游标没前进就不收这一页**（与 `features/listing/api.ts` 的 `fetchMyListings` 同一判据）：
 * 服务端若重复给同一个 cursor，收下等于把同一页叠 5 次。
 */
export async function fetchRentalFeed(args: RentalFeedArgs = {}): Promise<RentalFeedPage> {
  const items: RentalCard[] = []
  let cursor: string | undefined
  for (let page = 0; page < FEED_MAX_PAGES; page += 1) {
    const payload = await apiRequest(RENTAL_ROUTES.base, {
      query: {
        q: args.keyword,
        sort: args.sort ?? 'newest',
        limit: PAGE_SIZE,
        days: args.days,
        cursor,
      },
    })
    const parsed = RentalFeedResponseSchema.parse(payload)
    const next = parsed.nextCursor
    if (next !== null && next === cursor) return { items, truncated: true }
    items.push(...parsed.items)
    if (next === null) return { items, truncated: false }
    cursor = next
  }
  return { items, truncated: true }
}

/**
 * 出租详情。
 *
 * 404 返回 `null` 而不是抛错：详情页对「出租不存在 / 不可见」有专门的空态
 * （与 `fetchListingDetail` 同一取舍）。
 */
export async function fetchRentalDetail(id: string): Promise<RentalDetail | null> {
  try {
    const payload = await apiRequest(RENTAL_ROUTES.detail(id))
    return RentalDetailSchema.parse(payload)
  } catch (error) {
    if (isApiError(error) && error.status === 404) return null
    throw error
  }
}

/** 「我发布的出租」（本人作用域，含待审 / 已下架）。服务端封顶 50 条、不给游标。 */
export async function fetchMyRentals(): Promise<RentalCard[]> {
  const payload = await apiRequest(RENTAL_ROUTES.mine)
  return RentalFeedResponseSchema.parse(payload).items
}

/**
 * 发布出租（写路径）。
 *
 * 非 2xx 一律抛 `ApiError`，调用方据 `code` 分支：
 * - `RENTAL_NOT_ELIGIBLE`（403）：未通过教育邮箱认证 —— 引导去认证页；
 * - `RENTAL_CONTENT_BLOCKED`（422）：内容未过审，`details[{field,message}]` 指明改哪里；
 * - `USER_RESTRICTED` / `PHONE_REQUIRED`（403）：治理限制 / 未绑手机号（中间件给出）。
 */
export async function createRental(input: RentalCreateInput): Promise<RentalDetail> {
  const payload = await apiRequest(RENTAL_ROUTES.base, { method: 'POST', body: input })
  return RentalDetailSchema.parse(payload)
}

/** 编辑出租。`objectKeys` 省略 = 保持原图（与商品域同一取舍：详情不给 objectKey）。 */
export async function updateRental(id: string, input: RentalUpdateInput): Promise<RentalDetail> {
  const payload = await apiRequest(RENTAL_ROUTES.detail(id), { method: 'PATCH', body: input })
  return RentalDetailSchema.parse(payload)
}

/** 下架：`ACTIVE → OFFLINE`；对已 OFFLINE 幂等，返回最新详情。 */
export async function offlineRental(id: string): Promise<RentalDetail> {
  const payload = await apiRequest(RENTAL_ROUTES.offline(id), { method: 'POST' })
  return RentalDetailSchema.parse(payload)
}

/** 重新上架：`OFFLINE → ACTIVE`；对已 ACTIVE 幂等。 */
export async function onlineRental(id: string): Promise<RentalDetail> {
  const payload = await apiRequest(RENTAL_ROUTES.online(id), { method: 'POST' })
  return RentalDetailSchema.parse(payload)
}
