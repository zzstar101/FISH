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

/**
 * 一次「聊一聊」的任务令牌（#67 R3）。
 *
 * 换账号时页面能在渲染期清场（`ownerChanged`），但清不掉**已经发出去**的请求：
 * A 发起 `POST /conversations` → 切到 B → B 对同一商品发起自己的请求 → A 的旧响应
 * 返回。没有令牌时 A 的 `conversation.id` 会写进 B 的缓存、把 B 带进 A 的会话，
 * A 的收尾还会删掉 B 的在途标记，让 B 能重复点击。
 */
export interface ChatTask {
  readonly listingId: string
  readonly ownerId: string | null
  /** 本页归属账号的代次，只在换账号 / 卸载时前进。 */
  readonly epoch: number
  /** 本次任务的唯一序号，用于「只释放自己的锁」。 */
  readonly token: number
}

/**
 * 令牌是否仍然有效：账号、本页代次、在途归属**三者全等**。
 *
 * 为什么不能只看 `ownerId`：A→B→A 之后 `userId` 又等于 A，旧任务照样「匹配」，
 * 迟到的缓存写入与导航会回到 B 已经离开的账号上。
 *
 * 为什么代次不能复用列表加载的 `loadSeq`：那个每次 `load()` 都会前进
 * （从会话页返回触发 `useDidShow` 就一次），拿它当守卫会把一次仍然有效的建会话
 * 请求误判过期 —— 用户点了「聊一聊」又恰好回到本页，请求就被丢了。
 */
export function isCurrentChatTask(
  task: ChatTask,
  current: { ownerId: string | null; epoch: number; inFlightToken: number | undefined },
): boolean {
  return (
    current.ownerId === task.ownerId &&
    current.epoch === task.epoch &&
    current.inFlightToken === task.token
  )
}

/**
 * 收尾时是否该释放这次任务占的锁：**只认令牌**。
 *
 * 不比对 owner/epoch —— 那两个是「要不要采纳这次响应」的判据；锁的归属只由令牌决定。
 * 否则 A 的迟到 `finally` 会删掉 B 已经取得的锁，让 B 能重复点击、往导航栈压两个会话页。
 */
export function shouldReleaseChatTask(task: ChatTask, inFlightToken: number | undefined): boolean {
  return inFlightToken === task.token
}
