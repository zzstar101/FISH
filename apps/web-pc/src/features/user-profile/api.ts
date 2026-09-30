import { USER_ROUTES } from '@fish/contracts/users/routes'
import {
  type PublicUserListingsResponse,
  PublicUserListingsResponseSchema,
  type PublicUserProfile,
  PublicUserProfileSchema,
} from '@fish/contracts/users/schema'
import { apiRequest } from '../../lib/api-client'

/** 「TA 的在售」单页条数（契约 `PublicUserListingsQuerySchema.limit` 服务端封顶 50）。 */
export const USER_LISTINGS_PAGE_LIMIT = 20

/**
 * 他人主页的公开资料。**整条匿名可读**（服务端不挂 `requireAuth`），
 * 未登录访客也能看 —— 不要在前端加登录门。
 */
export async function fetchPublicProfile(userId: string): Promise<PublicUserProfile> {
  const payload = await apiRequest(USER_ROUTES.publicProfile(userId))
  return PublicUserProfileSchema.parse(payload)
}

/**
 * TA 的**在售**商品（`status = 'ACTIVE'`，时间倒序，游标分页）。
 *
 * 注意契约刻意**不**对不存在的用户返回空列表，而是 404 —— 否则端上会把
 * 「用户不存在」渲染成「TA 暂无在售商品」。调用方必须先确认资料拿到了再查这个。
 */
export async function fetchUserActiveListings(
  userId: string,
  cursor?: string,
  limit = USER_LISTINGS_PAGE_LIMIT,
): Promise<PublicUserListingsResponse> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (cursor !== undefined) params.set('cursor', cursor)
  const payload = await apiRequest(`${USER_ROUTES.activeListings(userId)}?${params.toString()}`)
  return PublicUserListingsResponseSchema.parse(payload)
}
