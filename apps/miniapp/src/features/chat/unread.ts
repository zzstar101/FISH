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
 */
import { useSyncExternalStore } from 'react'

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
 * Chat 页发布最新未读快照。值没变就不广播，避免列表重渲染触发无谓的红点重算。
 */
export function publishUnread(next: UnreadSnapshot): void {
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

/** 当前快照。Chat 页还没发布过时为 `null`，订阅方自行回退本地现算 */
function unreadSnapshot(): UnreadSnapshot | null {
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
