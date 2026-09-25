/**
 * 「我的」页账号作用域的生命周期判据（#170 D：返回本页时同步统计与资料）。
 *
 * 为什么抽出来：这几条判据本身就是本次的修复点（Tab 切回 / 从子页返回要重拉、
 * 迟到响应作废、刷新失败不把好数据翻成未知），但本页没有渲染测试基建，判据留在
 * `index.tsx` 里就没有任何用例能在它们被改坏时变红（同 `pages/match/view.ts`
 * 的既有取舍）。
 *
 * 边界：这里只覆盖**判据**（给定状态算出该不该刷新 / 该不该写入），不覆盖组件接线
 * （`useDidShow` 注册时机、回调闭包读到的登录态、`setProfile` 的调用顺序）。
 * 后者仍须在微信开发者工具里按 D 的时序实测，不能用本文件的用例代替端上验收。
 */

/** 冷启动 `unknown` 不抢跑、未登录不发；恢复到 `authed` 且有 `userId` 才允许发受限请求。 */
export function canLoad(authed: boolean, userId: string | null): boolean {
  return authed && userId !== null
}

/**
 * 返回本页（Tab 切回 / 从子页返回）是否需要重拉统计与资料。
 *
 * 首次 show 让渡给登录态 effect —— 那一次已经负责首屏加载，不跳过就会一进页双发；
 * 其余情况仍受登录态门禁约束（`unknown` 冷启动、未登录、退出登录后返回都不发
 * 受限请求）。与 `pages/match/view.ts` 的 `shouldReloadOnShow` 同一口径。
 */
export function shouldRefreshOnShow(input: {
  firstShow: boolean
  authed: boolean
  userId: string | null
}): boolean {
  if (input.firstShow) return false
  return canLoad(input.authed, input.userId)
}

/**
 * 迟到响应是否允许写入：只有序号仍是最新的那一次才作数。
 * 换号与卸载都会让序号前进，先发的响应后到即被判过期。
 */
export function isLatestLoad(seq: number, latest: number): boolean {
  return seq === latest
}

/**
 * 迟到的**更旧**快照是否允许落地。
 *
 * 与 `isLatestLoad` 分工不同：那条管「同一账号内，序号必须是最新一次取数」；这条管
 * **首屏链与返回刷新链之间的先后** —— 首屏请求更早发出（序号更小），弱网下却可能更晚
 * 返回，此时它不得覆盖返回刷新已经展示的更新快照，否则就是「丢掉了这次刷新」。
 *
 * 用 `>=` 而不是 `>`：同一个序号只会在「还没有更晚的取数」时落地。
 */
export function isNotOlderThan(seq: number, shownSeq: number): boolean {
  return seq >= shownSeq
}

/**
 * 刷新回来的快照能不能落地。三条缺一不可：
 *
 * 1. `null`（请求失败 / 真实构建 fail-closed）→ **不落地**。刷新失败要保留上一次
 *    的好数据：把 `profile` 清回 `null` 等于把「这次没问到」说成「系统不知道」，
 *    用户刚看到的统计会无端变成 `—`、昵称会退回 store 里的旧值。
 * 2. `next.user.id !== forUserId` → 不落地。快照必须属于**发请求时**的账号：
 *    `loadProfile` 在演示构建的失败回退里会返回演示账号的数据（见 `fetchers.ts`）。
 * 3. `currentUserId !== forUserId` → 不落地。发请求时是 A、落地时已经换成 B（或已
 *    退出）时，A 的快照不许画在 B 名下 —— 序号同一手法，这里是账号层面的兜底。
 */
export function acceptsRefreshedProfile<T extends { user: { id: string } }>(
  next: T | null,
  forUserId: string,
  currentUserId: string | null,
): next is T {
  if (next === null) return false
  return next.user.id === forUserId && currentUserId === forUserId
}
