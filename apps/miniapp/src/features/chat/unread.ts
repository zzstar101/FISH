/**
 * 消息域的未读快照：Chat 页发布，CustomTabBar 订阅。
 *
 * 为什么要有这一层：CustomTabBar 的实例**每个 Tab 页各有一份**，它读不到 Chat 页
 * 组件里的本地 state；此前它自己从 mock fixture 现算未读、effect 只依赖登录态，
 * 于是「进会话 / 看过通知」在消息页里清掉的未读，底栏「消息」红点一概不知道
 * （#129 review P1：进过通知 tab 后全局红点仍然亮着）。
 *
 * 这里用与 `features/auth/store` 同款的最小 store（模块级快照 + listeners +
 * `useSyncExternalStore`）把两边接起来：Chat 页的派生未读数一变就 `publishUnread`，
 * 各 Tab 页的底栏实例随之重算红点 —— 页内角标与全局红点从此同源。
 *
 * **冷启动**（#129 review 第二条 P1）：底栏是每个 Tab 页都渲染的，用户可能一次都没
 * 进过消息页，此时没有任何人 `publishUnread`。所以这里再提供 `hydrateUnread()` ——
 * 由底栏在「已登录 + 还没有本次账号的快照」时调一次真实 `GET /notifications/unread-count`
 * 来填快照；真实构建下**绝不回退 mock fixture**（fixture 的未读与真实账号无关，
 * 会造成「真实有未读却不亮」或「没有未读却亮着幽灵红点」两种错）。
 */
import { useSyncExternalStore } from 'react'
import { fetchUnreadNotificationCount } from '@/features/chat/api'

export type UnreadSnapshot = {
  /**
   * 快照归属的账号 id。**订阅方必须比对当前登录用户**：Chat 页实例可能被销毁
   * （守卫的 `reLaunch` 兜底会把整栈重开），那时没人调用 `clearUnread()`，
   * 不带归属的残留快照会拿上一个账号的已读视角替新账号熄底栏红点。
   */
  ownerId: string
  /** 会话未读**条数和**（Chat 页 `shown` 的口径，含本地已读清零的效果） */
  conversations: number
  /**
   * 通知未读数（Chat 页「通知」tab 角标同源：切进 tab 即 0）；
   * **`null` = 还不知道**（列表未就绪 / 加载失败）—— 订阅方按「无已知未读」算
   * （不是拿 fixture 顶替），与页内角标同口径：那时页内也是 0。
   */
  notifications: number | null
}

let snapshot: UnreadSnapshot | null = null
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * 「当前活跃账号」—— 用来判断一份迟到的补数结果是否已经过时。
 *
 * 两个入口都会更新它：`publishUnread`（消息页发布权威快照）与 `hydrateUnread`
 * （冷启动补数），因为两者都代表「现在轮到谁」。判据不能用「快照属于别人就不发布」：
 * Chat 页实例不存在时没人 `clearUnread()`，上一个账号的快照会一直留着，那条判据会把
 * 新账号自己的结果一并丢掉 → 新账号整场不亮红点。
 */
let latestOwner: string | null = null

/**
 * Chat 页发布最新未读快照。值没变就不广播，避免列表重渲染触发无谓的红点重算。
 */
export function publishUnread(next: UnreadSnapshot): void {
  // 先记活跃账号：即使下面因值没变而提前返回，这份快照也说明「现在是 next.ownerId」
  latestOwner = next.ownerId
  if (
    snapshot &&
    snapshot.ownerId === next.ownerId &&
    snapshot.conversations === next.conversations &&
    snapshot.notifications === next.notifications
  ) {
    return
  }
  snapshot = next
  for (const listener of listeners) listener()
}

/** 当前快照。给非 React 调用方（测试、调试）用，与 `features/auth/store` 的 `authSnapshot()` 同款 */
export function unreadSnapshot(): UnreadSnapshot | null {
  return snapshot
}

/**
 * 清空快照（登出 / 换账号时由 Chat 页调用）。
 *
 * Tab 页实例跨登录态存活，快照里的已读视角属于**上一个账号**；不清的话，
 * 底栏会拿上一个账号「看过通知 / 已读会话」的残留替下一个账号熄红点。
 * 清空后订阅方回退到快照前的本地现算口径。
 */
export function clearUnread(): void {
  // 登出即「没有活跃账号」：在途的补数结果回来后会被判为过时而丢弃
  latestOwner = null
  if (snapshot === null) return
  snapshot = null
  for (const listener of listeners) listener()
}

/**
 * 订阅未读快照（底栏红点用）。
 *
 * 第三参数（`getServerSnapshot`）与客户端同源：小程序没有 SSR，
 * 但 `useSyncExternalStore` 的类型要求提供它，传同一个函数即可。
 */
export function useUnreadSnapshot(): UnreadSnapshot | null {
  return useSyncExternalStore(subscribe, unreadSnapshot, unreadSnapshot)
}

/**
 * 冷启动补一次未读快照（底栏在「已登录 + 还没有本次账号的快照」时调用）。
 *
 * 为什么需要（#129 review 第二条 P1）：底栏在**每个 Tab 页**都渲染，用户完全可能
 * 一次都不进消息页；那时没人 `publishUnread`，快照为 `null`，底栏只能拿 mock fixture
 * 现算 —— 而 fixture 的未读与真实账号毫无关系，于是「真实有未读却不亮」与
 * 「没有未读却亮着幽灵红点」都会发生。
 *
 * 通知数走**真实** `GET /notifications/unread-count`。失败时：
 * - 调用方给了 `demoFallback`（演示 / 开发构建，本地根本没有后端）→ 用它的计数，
 *   否则演示环境里那颗红点会整个消失；
 * - 没给（真实构建）→ 发 `null`（「不知道」，底栏按无已知未读算），
 *   **不回退 fixture** —— 拿 fixture 顶替真实值正是幽灵红点 / 漏亮红点的成因。
 *
 * 兜底由调用方注入而不是本模块内判断构建开关：store 不该知道 mock fixture 的存在，
 * 这样它也不必 import `@/mock/api`（避免真实构建把整包 fixture 拖进底栏的依赖图）。
 *
 * 会话数由调用方传入（底栏从 fixture 现算）—— 会话未读的真实化是 #89 的既有债，
 * 不在本 PR 范围；这里只保证**通知**这一项不再用 fixture 顶替真实值。
 *
 * 并发去重：底栏实例每个 Tab 页各一份，多个实例会同时触发；同账号只发一次请求。
 */
const hydrating = new Set<string>()

export function hydrateUnread(
  ownerId: string,
  conversations: number,
  demoFallback?: () => number,
): void {
  // 记录「当前该为谁补数」：即使下面因为已有同账号快照而提前返回，也说明这个账号是当前的
  latestOwner = ownerId
  // 本次账号已经有快照（比如刚进过消息页）：那是含会话未读的权威值，不用补
  if (snapshot && snapshot.ownerId === ownerId) return
  if (hydrating.has(ownerId)) return
  hydrating.add(ownerId)
  void fetchUnreadNotificationCount()
    .then((count) => count)
    .catch(() => (demoFallback ? demoFallback() : null))
    .then((notifications) => {
      hydrating.delete(ownerId)
      // 期间消息页可能已经发布了权威快照（含会话未读），别用只含通知的这份盖回去
      if (snapshot && snapshot.ownerId === ownerId) return
      // 期间又为别的账号补过数：这份结果属于旧账号，丢掉（否则会把新账号的红点写回旧账号）
      if (latestOwner !== ownerId) return
      publishUnread({ ownerId, conversations, notifications })
    })
    .catch(() => {
      hydrating.delete(ownerId)
    })
}
