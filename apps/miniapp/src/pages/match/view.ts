/**
 * match 页账号作用域的生命周期判据（#170 A/B/C/D）。
 *
 * 为什么抽出来：这几条判据本身就是 #170 的修复点（冷启动不抢跑、换账号同步清场、
 * 迟到响应作废、子页返回重拉），但本页没有渲染测试基建，判据留在 `index.tsx` 里
 * 就没有任何用例能在它们被改坏时变红。
 *
 * 边界：这里只覆盖**判据**（给定状态算出该不该加载 / 该不该写入），不覆盖组件接线
 * （effect 触发顺序、渲染期 setState、`useDidShow` 注册时机）。后者仍须在微信开发者
 * 工具里按 A/B/C/D 的时序实测，不能用本文件的用例代替端上验收。
 */

/** 冷启动 `unknown` 不抢跑、未登录不发；恢复到 `authed` 且有 `userId` 才允许发受限请求。 */
export function canLoad(authed: boolean, userId: string | null): boolean {
  return authed && userId !== null
}

/**
 * 是否需要在**渲染期**同步清场：数据属于哪个账号变了（`null ↔ id` 两个方向都算）。
 * 用 effect 清场会晚一帧，那一帧画的是上一个账号的命中结果。
 */
export function ownerChanged(previous: string | null, next: string | null): boolean {
  return previous !== next
}

/**
 * 迟到响应是否允许写入：只有序号仍是最新的那一次才作数。
 * 连点重试与换账号都会让序号前进，先发的响应后到即被判过期。
 */
export function isLatestLoad(seq: number, latest: number): boolean {
  return seq === latest
}

/**
 * 从子页（商品详情 / 会话）返回时是否重拉。
 *
 * 首次 show 让渡给登录态 effect —— 那一次已经负责首屏加载，不跳过就会一进页双发；
 * 其余情况仍受登录态门禁约束（退出登录后返回不发受限请求）。
 */
export function shouldReloadOnShow(input: {
  firstShow: boolean
  authed: boolean
  userId: string | null
}): boolean {
  if (input.firstShow) return false
  return canLoad(input.authed, input.userId)
}
