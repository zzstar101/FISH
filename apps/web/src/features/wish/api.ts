import { WISH_ROUTES } from '@fish/contracts/wishes/routes'
import type { WishCreateInput, WishDto, WishPoolItem } from '@fish/contracts/wishes/schema'
import {
  wishDtoSchema,
  wishListResponseSchema,
  wishPoolResponseSchema,
} from '@fish/contracts/wishes/schema'
import { apiRequest } from '../../lib/api-client'

/** 我的愿望（全部状态，时间倒序）。P0 取第一页（pageSize 上限 50）。 */
export async function fetchMyWishes(): Promise<WishDto[]> {
  const payload = await apiRequest(`${WISH_ROUTES.base}?page=1&pageSize=50`)
  return wishListResponseSchema.parse(payload).items
}

/** 愿望池：全站聚合的关键词（wantCount / 预算中位数），没有所有者信息。 */
export async function fetchWishPool(): Promise<WishPoolItem[]> {
  const payload = await apiRequest(WISH_ROUTES.pool)
  return wishPoolResponseSchema.parse(payload).items
}

export async function createWish(input: WishCreateInput): Promise<WishDto> {
  return wishDtoSchema.parse(
    await apiRequest(WISH_ROUTES.base, { method: 'POST', body: JSON.stringify(input) }),
  )
}

/** 关闭愿望：ACTIVE → CLOSED（服务端校验归属）。 */
export async function closeWish(id: string): Promise<WishDto> {
  return wishDtoSchema.parse(await apiRequest(WISH_ROUTES.close(id), { method: 'POST' }))
}
