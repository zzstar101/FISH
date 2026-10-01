/**
 * 关注关系的 API（Issue #188）。
 *
 * 路径一律取自契约常量（`@fish/contracts/follows/routes`），不硬编码字符串；
 * 响应一律用契约 schema 收口，形状漂移在解析处就炸，而不是渲染到页面上才炸。
 *
 * **没有 mock 回退**：这三个函数只做真实请求。演示构建下的演示列表由
 * `features/following/load.ts` 直接取 fixture，不走这里（见该文件的口径）。
 */
import { FOLLOW_ROUTES } from '@fish/contracts/follows/routes'
import {
  type FollowState,
  FollowStateSchema,
  type MyFollowingResponse,
  MyFollowingResponseSchema,
} from '@fish/contracts/follows/schema'
import { apiRequest } from '@/lib/request'

/**
 * 「我的关注」一页的条数。契约 `MyFollowingQuerySchema` 的上限是 50；取 20 让首屏快、
 * 又不会把滚动加载切得太碎（与 `pages/wish` 的列表页同一档）。
 */
export const FOLLOWING_PAGE_SIZE = 20

/** 我关注的人（`GET /me/following`）。未登录 → 401 `UNAUTHENTICATED`，由调用方分支。 */
export async function fetchMyFollowing(cursor?: string): Promise<MyFollowingResponse> {
  const payload = await apiRequest(FOLLOW_ROUTES.myFollowing, {
    query: { limit: FOLLOWING_PAGE_SIZE, cursor },
  })
  return MyFollowingResponseSchema.parse(payload)
}

/** 我对某个人的关注状态（`GET /users/:userId/follow`）。404 = 目标不存在（调用方分支）。 */
export async function fetchFollowState(userId: string): Promise<FollowState> {
  const payload = await apiRequest(FOLLOW_ROUTES.followRelation(userId))
  return FollowStateSchema.parse(payload)
}

/**
 * 关注 / 取关（`POST` / `DELETE` 同一路径）。幂等：重复关注 / 重复取关都是 200。
 *
 * 回包是服务端算出的**关系真值**（含 mutual），调用方直接采用它，不要本地翻转：
 * 「成功以服务端为准」是验收条目，端上自己猜 mutual 会把单向关系画成互粉。
 */
export async function setFollow(userId: string, follow: boolean): Promise<FollowState> {
  const payload = await apiRequest(FOLLOW_ROUTES.followRelation(userId), {
    method: follow ? 'POST' : 'DELETE',
  })
  return FollowStateSchema.parse(payload)
}
