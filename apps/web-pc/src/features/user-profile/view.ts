import type { PublicUserProfile } from '@fish/contracts/users/schema'
import { ApiError } from '../../lib/api-client'

/**
 * `404 USER_NOT_FOUND`。服务端**刻意**让「非法 id」与「用户不存在」返回同一个响应
 * （这条路径任何匿名请求都能稳定触发，区分两者等于给出一份用户 id 空间探针）。
 * 端上据此渲染「用户不存在」，而不是「TA 暂无在售商品」。
 *
 * 同时校验 `status === 404`：契约把 `USER_NOT_FOUND` 固定为 404，只比对 code 的话，
 * 将来别处复用这个码会把非 404 也判成「用户不存在」。
 */
export function isUserNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && error.code === 'USER_NOT_FOUND'
}

/**
 * 主页上展示的三个统计，来源是 `PublicUserProfileSchema` 的 `joinedDays / activeCount / soldCount`。
 *
 * 契约的公开 DTO（九个字段，见 `@fish/contracts/users/schema` 头部）**没有**好评率 /
 * 关注数 / 成交金额，所以这里不编造任何额外指标：
 * - 好评率：`transaction_reviews` 表（`packages/db/src/schema/transaction-reviews.ts`）与
 *   `@fish/contracts/transaction-reviews` 契约（#195 PR2）都已存在，但评价按交易参与方授权，
 *   不是这份「同一响应给所有人」的匿名公开读模型的一部分；
 * - 关注数：按视角单独放在 follows Domain（#188，`GET /me/following` 与
 *   `/users/:userId/follow`），同样不属于这份匿名公开读模型。
 */
export function profileStats(
  profile: PublicUserProfile,
): ReadonlyArray<{ label: string; value: number }> {
  return [
    { label: '加入天数', value: profile.joinedDays },
    { label: '在售商品', value: profile.activeCount },
    { label: '卖出', value: profile.soldCount },
  ]
}
