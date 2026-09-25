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
import { fetchConversationUnreadCount, fetchUnreadNotificationCount } from '@/features/chat/api'

export type UnreadSnapshot = {
  /**
   * 快照归属的账号 id。**订阅方必须比对当前登录用户**：Chat 页实例可能被销毁
   * （守卫的 `reLaunch` 兜底会把整栈重开），那时没人调用 `clearUnread()`，
   * 不带归属的残留快照会拿上一个账号的已读视角替新账号熄底栏红点。
   */
  ownerId: string
  /**
   * 会话未读**条数和**（Chat 页会话列表的口径）。两个来源同源：Chat 页发布自己
   * 那份真实列表的求和，冷启动由 `hydrateUnread` 拉 `GET /conversations` 求和。
   *
   * **`null` = 还不知道**（列表未就绪 / 加载失败）—— 订阅方按「无已知未读」算。
   * 不能用 0 表达「不知道」：那会把上一份正确的快照覆盖成「没有未读」，用户明明
   * 还有未读、底栏那颗点却熄了。两个字段的「不知道」必须同一种表达。
   */
  conversations: number | null
  /**
   * 通知未读数（Chat 页「通知」tab 角标同源：切进 tab 即 0）；
   * **`null` = 还不知道**（列表未就绪 / 加载失败）—— 订阅方按「无已知未读」算
   * （不是拿 fixture 顶替），与页内角标同口径：那时页内也是 0。
   */
  notifications: number | null
}

let snapshot: UnreadSnapshot | null = null
const listeners = new Set<() => void>()

/**
 * 底栏「消息」红点该不该亮。
 *
 * 规则（也是「不知道」这个态存在的意义）：
 * 1. 只要有任何一项**已知**未读 > 0 → 亮；
 * 2. 两项都已知且都是 0 → 熄；
 * 3. 有分量「不知道」且没有已知未读 → **保持上一帧**，不下「没有未读」这个结论。
 *
 * 第 3 条是关键：接口失败 / 列表还没到手时如果按 0 算，一颗本来亮着的点会莫名其妙
 * 熄掉，而用户其实还有未读 —— 这与「没读到 ≠ 恰好没有」是同一条原则。
 * 抽成纯函数是为了它能被单测锁住（底栏组件本身没有渲染测试基建）。
 */
export function badgeShouldLight(input: {
  conversations: number | null
  notifications: number | null
  /** 上一帧的红点状态 */
  previous: boolean
}): boolean {
  if ((input.conversations ?? 0) > 0 || (input.notifications ?? 0) > 0) return true
  const unknown = input.conversations === null || input.notifications === null
  return unknown ? input.previous : false
}

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
 * 权威快照的版本号：`publishUnread`（消息页发布）与 `clearUnread`（登出 / 换账号清场）
 * 各递增一次。
 *
 * 用来作废「在此之前发出的」补数 / 刷新结果（#170 D）：底栏显示时会重取未读，
 * 若这期间消息页已经发布了更权威的值（含页内已读回写），那份旧结果不能盖回去。
 * 只比对 `latestOwner` 挡不住这种交错 —— 同一个账号登出再登录时它会变回同一个 id。
 */
let snapshotSeq = 0

/**
 * Chat 页发布最新未读快照。值没变就不广播，避免列表重渲染触发无谓的红点重算。
 */
export function publishUnread(next: UnreadSnapshot): void {
  // 先记活跃账号：即使下面因值没变而提前返回，这份快照也说明「现在是 next.ownerId」
  latestOwner = next.ownerId
  // 值没变也算「更权威的一次发布」：在它之前发出的补数 / 刷新结果都该作废
  snapshotSeq += 1
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
  // 同时作废在途结果：同一账号登出再登录时 `latestOwner` 会变回同一个 id，光靠它挡不住
  snapshotSeq += 1
  // 去重表也得清：否则同一账号马上重新登录时，这次补数会被「还在途」的旧请求吞掉，
  // 而旧请求的结果又已被上面的序号作废 —— 这一轮登录就没人再取数了（窗口=一次往返）。
  // 迟到的旧结果不会因此复活：它落地前仍要过序号与账号两道校验。
  hydrating.clear()
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
 * 在途的取数任务：`ownerId → requestToken`。底栏实例每个 Tab 页各一份，多个实例会同时
 * 触发；同账号只发一次请求。
 *
 * 值必须是**这一次任务**的令牌，不能只记 `ownerId`（#170 复查 N7）：同一账号「退出 →
 * 马上重新登录」会起一个新任务，旧任务的 `finally` 若无条件 `delete(ownerId)`，就会把
 * 新任务的去重项一起删掉 —— 下一次显示于是又能发一次请求，而它可能和仍在途的新任务抢
 * 同一个 `snapshotSeq`，旧结果先落地就把新结果挤掉了。登出（`clearUnread`）整表清掉。
 */
const hydrating = new Map<string, number>()

/** 在途任务的令牌发号器：每真的发一次请求就 +1（与快照的 `snapshotSeq` 分开建模） */
let requestToken = 0

/** 演示 / 开发构建注入的兜底计数（真实构建不传：读不到就是「不知道」） */
type UnreadFallback = () => { conversations: number; notifications: number }

/**
 * 补数 / 刷新的公共实现。两个入口只差两处口径：
 *
 * - `fill`（冷启动补数）：本账号**已有快照就不再请求** —— 那是含会话未读的权威值；
 * - `refresh`（显示时刷新，#170 D）：每次显示都重取，且**不下调已知值** ——
 *   某一项没拿到（`null` = 不知道）时沿用旧快照，绝不把「知道」写成「不知道」，
 *   否则一次失败的网络请求会把底栏已知的未读抹掉。两项都没拿到就干脆不发布。
 *
 * 两者共用的作废判据是 `snapshotSeq`：请求发出后若出现更权威的快照
 * （消息页发布 / 登出清场），这份结果直接丢弃 —— 迟到的旧值不许盖回新值。
 */
function requestUnread(
  ownerId: string,
  demoFallback: UnreadFallback | undefined,
  mode: 'fill' | 'refresh',
): void {
  // 记录「当前该为谁取数」：即使下面因为已有同账号快照而提前返回，也说明这个账号是当前的
  latestOwner = ownerId
  // 本次账号已经有快照（比如刚进过消息页）：那是含会话未读的权威值，不用补
  if (mode === 'fill' && snapshot && snapshot.ownerId === ownerId) return
  if (hydrating.has(ownerId)) return
  // 占位记的是**本次任务**的令牌：`finally` 只释放自己那一个（同账号退出→重登会起新任务）
  requestToken += 1
  const token = requestToken
  hydrating.set(ownerId, token)
  // 记下发起时刻的版本：期间若有人发布了更权威的快照，这份结果就算过时
  const startedAt = snapshotSeq
  void Promise.all([
    fetchUnreadNotificationCount().catch(() => null),
    fetchConversationUnreadCount().catch(() => null),
  ])
    .then(([notifications, conversations]) => {
      // 期间出现了更新的权威快照（消息页发布 / 登出清场）：这份结果已经过时，丢掉
      if (snapshotSeq !== startedAt) return
      // 期间又为别的账号取过数：这份结果属于旧账号，丢掉（否则会把新账号的红点写回旧账号）
      if (latestOwner !== ownerId) return
      // 两项只要有一项没拿到，就走演示兜底；真实构建下兜底是 undefined
      const fallback =
        notifications === null || conversations === null ? demoFallback?.() : undefined
      // 拿不到 = 「不知道」：真实构建发 null（底栏按无已知未读算），演示构建用兜底值。
      // **不发 0** —— 0 是「确定没有未读」这个具体结论。
      const next: UnreadSnapshot = {
        ownerId,
        conversations: conversations ?? fallback?.conversations ?? null,
        notifications: notifications ?? fallback?.notifications ?? null,
      }
      if (mode === 'fill') {
        publishUnread(next)
        return
      }
      // 刷新：没拿到的那一项沿用旧快照（同账号才可信），不下调成「不知道」
      const previous = snapshot && snapshot.ownerId === ownerId ? snapshot : null
      const merged: UnreadSnapshot = {
        ownerId,
        conversations: next.conversations ?? previous?.conversations ?? null,
        notifications: next.notifications ?? previous?.notifications ?? null,
      }
      // 一项已知值都没有（真实构建两路失败、又没有旧快照）：没有新信息可发布，保持现状
      if (merged.conversations === null && merged.notifications === null) return
      publishUnread(merged)
    })
    .catch(() => {})
    // 在途去重项的释放在 finally 里做，与走到哪条分支无关：若把它放在 `.then` 开头，
    // 上面那条「已被更权威快照作废」的早退路径就不会释放，这个账号从此每次显示时刷新
    // 都被 `hydrating.has(ownerId)` 吞掉 —— D 会静默失效，直到下一次登出清场才恢复。
    .finally(() => {
      // 只释放**自己**那一个占位（#170 复查 N7）：同一账号「退出 → 重登」会起新任务，
      // 无条件 `delete(ownerId)` 会把新任务的去重项一起删掉，D 的共享去重就漏了。
      if (hydrating.get(ownerId) === token) hydrating.delete(ownerId)
    })
}

/**
 * 冷启动补一次未读快照（底栏在「已登录 + 还没有本次账号的快照」时调用）。
 *
 * 为什么需要（#129 review 第二条 P1）：底栏在**每个 Tab 页**都渲染，用户完全可能
 * 一次都不进消息页；那时没人 `publishUnread`，快照为 `null`，底栏只能拿 mock fixture
 * 现算 —— 而 fixture 的未读与真实账号毫无关系，于是「真实有未读却不亮」与
 * 「没有未读却亮着幽灵红点」都会发生。
 *
 * 通知数走**真实** `GET /notifications/unread-count`；会话数走**真实**
 * `GET /conversations/unread-count` 聚合（`fetchConversationUnreadCount`）——
 * 它不再对第一页会话求和，所以会话数超过一页时底栏也不会漏计（#67）。失败时：
 * - 调用方给了 `demoFallback`（演示 / 开发构建，本地根本没有后端）→ 用它的计数，
 *   否则演示环境里那颗红点会整个消失；
 * - 没给（真实构建）→ 两项都发 `null`（「不知道」，底栏按无已知未读算），
 *   **不回退 fixture** —— 拿 fixture 顶替真实值正是幽灵红点 / 漏亮红点的成因。
 *
 * 兜底由调用方注入而不是本模块内判断构建开关：store 不该知道 mock fixture 的存在，
 * 这样它也不必 import `@/mock/api`（避免真实构建把整包 fixture 拖进底栏的依赖图）。
 *
 * 并发去重：底栏实例每个 Tab 页各一份，多个实例会同时触发；同账号只发一次请求。
 */
export function hydrateUnread(ownerId: string, demoFallback?: UnreadFallback): void {
  requestUnread(ownerId, demoFallback, 'fill')
}

/**
 * 显示时刷新未读快照（#170 D：底栏每次显示都重取一次真实值）。
 *
 * 为什么需要：底栏实例在每个 Tab 页各一份，且**跨「切 Tab / 后台回前台」存活** ——
 * 只在挂载时补一次的话，别处产生的未读（新消息、另一台设备已读）在底栏上永远不更新。
 *
 * 走的是与冷启动补数**同一套**真实接口（`GET /notifications/unread-count` +
 * `GET /conversations/unread-count` 聚合），不另造求和规则；迟到的结果由 `snapshotSeq`
 * 作废，失败不下调已知值，未登录由调用方拦住。
 */
export function refreshUnread(ownerId: string, demoFallback?: UnreadFallback): void {
  requestUnread(ownerId, demoFallback, 'refresh')
}
