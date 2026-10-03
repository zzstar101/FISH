import { FAVORITE_ROUTES } from '@fish/contracts/favorites/routes'
import {
  FavoriteStateSchema,
  type MyFavoritesResponse,
  MyFavoritesResponseSchema,
} from '@fish/contracts/favorites/schema'
import { ListingIdSchema } from '@fish/contracts/listings/schema'
import { ApiError, apiRequest } from '../../lib/api-client'

/** 收藏列表每页条数：契约默认 20、上限 50，端上取默认。 */
export const FAVORITES_PAGE_LIMIT = 20

export function myFavoritesPath(input: { limit: number; cursor?: string }): string {
  const params = new URLSearchParams({ limit: String(input.limit) })
  if (input.cursor !== undefined) params.set('cursor', input.cursor)
  return `${FAVORITE_ROUTES.myFavorites}?${params.toString()}`
}

/** 商品 id 是用户可见输入（路由参数），拼 URL 前先过契约校验，不合法直接当不存在。 */
export function favoriteRelationPath(listingId: string): string | null {
  if (!ListingIdSchema.safeParse(listingId).success) return null
  return FAVORITE_ROUTES.favoriteRelation(listingId)
}

export async function fetchMyFavorites(input: {
  limit: number
  cursor?: string
}): Promise<MyFavoritesResponse> {
  return MyFavoritesResponseSchema.parse(await apiRequest(myFavoritesPath(input)))
}

export type FavoriteStateOutcome =
  | { kind: 'loaded'; favorited: boolean }
  | { kind: 'notFound' }
  | { kind: 'failed'; message: string }

function favoriteStateErrorText(error: unknown): string {
  if (error instanceof ApiError && error.message.length > 0) return error.message
  return '网络异常，请稍后重试'
}

/**
 * 读当前用户对某商品的收藏态。404（不存在/不可见/不在售）单独成 `notFound`，
 * 与网络/服务端失败分开——按钮区对前者降级为「不可收藏」，对后者保留重试。
 */
export async function fetchFavoriteState(listingId: string): Promise<FavoriteStateOutcome> {
  const path = favoriteRelationPath(listingId)
  if (path === null) return { kind: 'notFound' }
  try {
    const state = FavoriteStateSchema.parse(await apiRequest(path))
    return { kind: 'loaded', favorited: state.favorited }
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { kind: 'notFound' }
    return { kind: 'failed', message: favoriteStateErrorText(error) }
  }
}

export type FavoriteWriteResult =
  | { kind: 'written'; favorited: boolean }
  | { kind: 'failed'; message: string }

/** 收藏/取消的失败都走这里：调用方以服务端结果为准，失败不改本地状态。 */
export function favoriteWriteErrorText(error: unknown): string {
  if (error instanceof ApiError && error.message.length > 0) return error.message
  return '网络异常，请稍后重试'
}

async function writeFavorite(
  listingId: string,
  method: 'POST' | 'DELETE',
): Promise<FavoriteWriteResult> {
  const path = favoriteRelationPath(listingId)
  if (path === null) return { kind: 'failed', message: '商品不存在或不可见' }
  try {
    const state = FavoriteStateSchema.parse(await apiRequest(path, { method }))
    return { kind: 'written', favorited: state.favorited }
  } catch (error) {
    return { kind: 'failed', message: favoriteWriteErrorText(error) }
  }
}

export function requestFavorite(listingId: string): Promise<FavoriteWriteResult> {
  return writeFavorite(listingId, 'POST')
}

export function requestUnfavorite(listingId: string): Promise<FavoriteWriteResult> {
  return writeFavorite(listingId, 'DELETE')
}
