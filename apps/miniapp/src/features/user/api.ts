/**
 * 公开用户主页 API（Issue #122）。
 *
 * 路径一律取自契约常量（`@fish/contracts/users/routes`），不硬编码字符串；
 * 响应一律用契约 schema 收口，形状漂移在解析处就炸，而不是渲染到页面上才炸。
 *
 * **404 统一解析成 `null`**：后端对「非法 uuid」与「不存在的用户」给同一个 404
 * `USER_NOT_FOUND`（刻意不区分，见契约注释）。调用方据此把「这个人不存在」与
 * 「没问到」分开，不在这层抛错。
 */
import { USER_ROUTES } from '@fish/contracts/users/routes'
import {
  type PublicUserListingsResponse,
  PublicUserListingsResponseSchema,
  type PublicUserProfile,
  PublicUserProfileSchema,
} from '@fish/contracts/users/schema'
import { apiRequest, isApiError } from '@/lib/request'

/**
 * 在售列表单页上限。
 *
 * 契约 `PublicUserListingsQuerySchema` 的 `limit` 上限是 50，超了会被 422 拒掉；
 * 本页是瀑布流首屏（没有无限滚动），取满一页就够 demo 数据量。
 * 若某天 TA 的在售超过这个数，页面顶部显示的是服务端给的 `activeCount`（真实总数），
 * 列表只列出一页 —— 两个数不一致时以服务端计数为准，不谎报「只有 50 件」。
 */
const PAGE_SIZE = 50

/** 公开资料。404（非法 uuid / 不存在）→ `null`。 */
export async function fetchPublicUserProfile(userId: string): Promise<PublicUserProfile | null> {
  try {
    const payload = await apiRequest(USER_ROUTES.publicProfile(userId))
    return PublicUserProfileSchema.parse(payload)
  } catch (error) {
    if (isApiError(error) && error.status === 404) return null
    throw error
  }
}

/**
 * TA 的在售商品（只含 ACTIVE）。404 → `null`。
 *
 * **不传 `cursor`**：本页没有无限滚动。契约仍保留分页能力（`nextCursor`），
 * 页面不需要它，所以这里不消费 —— 不为了「以后可能要做」而在页面里堆状态。
 */
export async function fetchPublicUserListings(
  userId: string,
): Promise<PublicUserListingsResponse | null> {
  try {
    const payload = await apiRequest(USER_ROUTES.activeListings(userId), {
      query: { limit: PAGE_SIZE },
    })
    return PublicUserListingsResponseSchema.parse(payload)
  } catch (error) {
    if (isApiError(error) && error.status === 404) return null
    throw error
  }
}
