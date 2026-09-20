/**
 * 「我的」页真实统计的**未知态口径**。
 *
 * 为什么单独抽出来：这些数字来自 `GET /profile`，请求失败 / 还没回来时它们是
 * **未知**，不是业务事实 0。把未知显示成 0 会让用户以为自己的数据丢了
 * （#127 review P1：`profile?.orderCount ?? 0`、`profile?.stats.activeWishes ?? 0`
 * 这类写法正是把「接口没答上」说成「你有 0 条」）。
 *
 * 口径统一为：
 * - `ProfileView` 为 `null`（未登录 / 未就绪 / 请求失败）→ 所有真实计数 `null`；
 * - 页面把 `null` 渲染成 `—`（数字栏）、图标栏**不显示红点**；
 * - 只有接口明确返回 0 才展示 0。
 */

/** 页面需要的 profile 切片（只列本模块用到的字段，避免与 `ProfileView` 耦合） */
export type ProfileCounts = {
  orderCount: number
  stats: { activeWishes: number; activeListings: number }
}

export type RealCounts = {
  /** 数字栏「我的愿望」 */
  activeWishes: number | null
  /** 图标栏「全部订单」的角标 */
  orderCount: number | null
  /** 图标栏「在售」的角标 */
  activeListings: number | null
}

export function realCounts(profile: ProfileCounts | null): RealCounts {
  return {
    activeWishes: profile?.stats.activeWishes ?? null,
    orderCount: profile?.orderCount ?? null,
    activeListings: profile?.stats.activeListings ?? null,
  }
}
