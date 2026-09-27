import { CHAT_ROUTES } from '@fish/contracts/chat/routes'
import { conversationDtoSchema } from '@fish/contracts/chat/schema'
import { LISTING_ROUTES } from '@fish/contracts/listings/routes'
import {
  type ListingFeedResponse,
  ListingFeedResponseSchema,
} from '@fish/contracts/listings/schema'
import { MATCHING_ROUTES } from '@fish/contracts/matching/routes'
import {
  type ListingMatchListResponse,
  ListingMatchListResponseSchema,
  type WishMatchListResponse,
  WishMatchListResponseSchema,
} from '@fish/contracts/matching/schema'
import { WISH_ROUTES } from '@fish/contracts/wishes/routes'
import {
  type WishCreateInput,
  type WishDto,
  type WishListResponse,
  type WishPoolResponse,
  type WishStatus,
  type WishUpdateInput,
  wishDtoSchema,
  wishListResponseSchema,
  wishPoolResponseSchema,
} from '@fish/contracts/wishes/schema'
import { ApiError, apiRequest } from '../../lib/api-client'

export type WishStatusFilter = WishStatus | 'ALL'
export const WISH_PAGE_SIZE = 50
export const MATCH_PAGE_LIMIT = 50

export function wishListPath(
  status: WishStatusFilter = 'ALL',
  page = 1,
  pageSize = WISH_PAGE_SIZE,
): string {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
  })
  if (status !== 'ALL') params.set('status', status)
  return `${WISH_ROUTES.base}?${params.toString()}`
}

export function wishMatchPath(wishId: string, limit = MATCH_PAGE_LIMIT): string {
  const params = new URLSearchParams({ wishId, limit: String(limit) })
  return `${MATCHING_ROUTES.base}?${params.toString()}`
}

export function listingMatchPath(listingId: string, limit = MATCH_PAGE_LIMIT): string {
  const params = new URLSearchParams({ listingId, limit: String(limit) })
  return `${MATCHING_ROUTES.base}?${params.toString()}`
}

/**
 * 预算输入：元 → 整数分。`allowEmpty` 用于下限 0（不设下限）；上限必须显式填写且 > 0。
 * 最多两位小数，避免把 12.345 元静默四舍五入成另一笔预算。
 */
export function parseBudgetCents(value: string, allowEmpty = false): number | null {
  const text = value.trim()
  if (text === '') return allowEmpty ? 0 : null
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null
  const cents = Math.round(Number(text) * 100)
  if (!Number.isSafeInteger(cents) || cents < 0) return null
  return cents
}

/** 愿望池公开聚合，只有关键词 / 分类 / 数量 / 中位预算，不渲染个人身份。 */
export async function fetchWishPool(): Promise<WishPoolResponse> {
  return wishPoolResponseSchema.parse(await apiRequest(WISH_ROUTES.pool))
}

/** 我的愿望：按服务端 page/pageSize 返回一页与总数。 */
export async function fetchMyWishes(
  status: WishStatusFilter = 'ALL',
  page = 1,
  pageSize = WISH_PAGE_SIZE,
): Promise<WishListResponse> {
  return wishListResponseSchema.parse(await apiRequest(wishListPath(status, page, pageSize)))
}

export async function fetchWish(id: string): Promise<WishDto> {
  return wishDtoSchema.parse(await apiRequest(WISH_ROUTES.detail(id)))
}

export async function createWish(input: WishCreateInput): Promise<WishDto> {
  return wishDtoSchema.parse(
    await apiRequest(WISH_ROUTES.base, { method: 'POST', body: JSON.stringify(input) }),
  )
}

export async function updateWish(id: string, input: WishUpdateInput): Promise<WishDto> {
  return wishDtoSchema.parse(
    await apiRequest(WISH_ROUTES.detail(id), { method: 'PATCH', body: JSON.stringify(input) }),
  )
}

export async function closeWish(id: string): Promise<WishDto> {
  return wishDtoSchema.parse(await apiRequest(WISH_ROUTES.close(id), { method: 'POST' }))
}

export async function fulfillWish(id: string): Promise<WishDto> {
  return wishDtoSchema.parse(await apiRequest(WISH_ROUTES.fulfill(id), { method: 'POST' }))
}

/** 愿望侧：我的愿望命中的在售商品，含当前可见匹配总数。 */
export async function fetchWishMatches(
  wishId: string,
  limit = MATCH_PAGE_LIMIT,
): Promise<WishMatchListResponse> {
  return WishMatchListResponseSchema.parse(await apiRequest(wishMatchPath(wishId, limit)))
}

/** 商品侧：我的商品对应的求购愿望，含当前可见匹配总数。 */
export async function fetchListingMatches(
  listingId: string,
  limit = MATCH_PAGE_LIMIT,
): Promise<ListingMatchListResponse> {
  return ListingMatchListResponseSchema.parse(await apiRequest(listingMatchPath(listingId, limit)))
}

/** 商品侧匹配入口路径：cursor 原样回传，服务端负责不重不漏。 */
export function myListingsForMatchesPath(ownerId: string, cursor?: string): string {
  const params = new URLSearchParams({ sellerId: ownerId, limit: '50' })
  if (cursor !== undefined) params.set('cursor', cursor)
  return `${LISTING_ROUTES.base}?${params.toString()}`
}

/** 匹配商品入口：按 cursor 逐页取当前账号自己的发布。 */
export async function fetchMyListingsForMatches(
  ownerId: string,
  cursor?: string,
): Promise<ListingFeedResponse> {
  return ListingFeedResponseSchema.parse(
    await apiRequest(myListingsForMatchesPath(ownerId, cursor)),
  )
}

/** 从匹配商品创建/复用会话；后端保证同一 (listingId, 买家) 幂等复用。 */
export async function startConversation(listingId: string): Promise<string> {
  return conversationDtoSchema.parse(
    await apiRequest(CHAT_ROUTES.base, {
      method: 'POST',
      body: JSON.stringify({ listingId }),
    }),
  ).id
}

/** 愿望写操作失败：状态冲突刷新列表，权限/不存在给可理解文案。 */
export function wishActionError(error: unknown): { message: string; refresh: boolean } {
  if (error instanceof ApiError) {
    if (error.status === 409) return { message: '愿望状态已变化，正在刷新最新状态', refresh: true }
    if (error.status === 403) return { message: '只能操作自己的愿望', refresh: false }
    if (error.status === 404) return { message: '愿望不存在或已不可用', refresh: true }
    return { message: error.message, refresh: false }
  }
  return { message: '操作失败，请稍后重试', refresh: false }
}

/** 匹配读取失败：不把权限/不存在错误伪装成空匹配。 */
export function wishMatchError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'NOT_TARGET_OWNER') return '只能查看自己愿望或商品的匹配结果'
    if (error.code === 'MATCH_TARGET_NOT_FOUND') return '匹配目标不存在或当前账号无权查看'
    if (error.code === 'UNAUTHENTICATED') return '登录状态已失效'
    return error.message
  }
  return '匹配结果加载失败，请稍后重试'
}

/** 从匹配结果发起会话的失败文案。 */
export function conversationStartError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'CANNOT_CHAT_WITH_SELF') return '不能和自己的商品发起会话'
    if (error.code === 'LISTING_NOT_FOUND') return '商品已不存在'
    if (error.code === 'CONVERSATION_NOT_FOUND') return '会话不存在或无权访问'
    return error.message
  }
  return '发起会话失败，请稍后重试'
}
