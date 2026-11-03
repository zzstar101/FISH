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
 * 单页条数上限。
 *
 * 契约 `PublicUserListingsQuerySchema` 的 `limit` 上限是 50，超了会被 422 拒掉。
 * 他人主页两段都按这个大小翻页（#565 加了「加载更多」）：页头显示的是服务端给的
 * `activeCount` / `soldCount`（真实总数），列表只列已翻到的部分 —— 两个数不一致时
 * 以服务端计数为准，并在列表尾注里如实说「仅显示最近 N 件」。
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
 * 公开商品列表的口径（#565）：缺省 / `ACTIVE` = 在售，`SOLD` = 已售出。
 *
 * 与契约 `PublicUserListingsQuerySchema.status` 的值域逐字相同 —— 已下架（OFFLINE）与
 * 已预定（RESERVED）不属于公开读模型，端上也不该有第三种口径。
 */
export type PublicUserListingsStatus = 'ACTIVE' | 'SOLD'

/**
 * TA 的商品列表（缺省在售）。404 → `null`。
 *
 * `cursor` 由服务端给出，前端只原样回传：他人主页的两段都用它做「加载更多」。
 */
export async function fetchPublicUserListings(
  userId: string,
  options: { status?: PublicUserListingsStatus; cursor?: string } = {},
): Promise<PublicUserListingsResponse | null> {
  try {
    const payload = await apiRequest(USER_ROUTES.activeListings(userId), {
      query: { limit: PAGE_SIZE, status: options.status, cursor: options.cursor },
    })
    return PublicUserListingsResponseSchema.parse(payload)
  } catch (error) {
    if (isApiError(error) && error.status === 404) return null
    throw error
  }
}
