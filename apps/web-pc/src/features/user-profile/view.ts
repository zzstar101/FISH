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
 * 关注数 / 成交金额，所以这里不编造任何额外指标。这三项各自被排除的理由（好评率口径未定、
 * 关注数属 follows Domain 的视角、成交金额不进公开读模型）由该契约头部逐条记录，
 * 那里是唯一出处，此处不再重复。
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
