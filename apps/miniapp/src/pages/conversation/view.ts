import type { MessageDto } from '@fish/contracts/chat/schema'

/**
 * 会话页的展示逻辑（#89：从 fixture 改为真实历史 / 发送 / 已读）。
 *
 * 与 `pages/chat/list-view.ts` 同一手法：把「界面上写什么」抽成纯函数，
 * 组件只负责渲染。这里锁的是三类曾经靠人眼复审的判定：
 * 交易 SYSTEM 事件的中文化、时间文案、以及发送失败态。
 */

/** 交易 SYSTEM 事件（`transactions/schema.ts` 的 `tx.*` 协议） */
export type TxEvent = { type: string }

/**
 * 解析交易 SYSTEM 事件的 JSON；非 JSON（普通文本系统消息）返回 null。
 * 与消息列表页的预览降级口径一致：解析不了就按原文渲染。
 */
export function parseTxEvent(content: string): TxEvent | null {
  try {
    const event: unknown = JSON.parse(content)
    if (event && typeof event === 'object' && 'type' in event) {
      const type = (event as { type: unknown }).type
      if (typeof type === 'string') return { type }
    }
  } catch {
    // 非 JSON：当普通文本
  }
  return null
}

/**
 * 不属于专门卡片的 SYSTEM 消息的胶囊文案。
 *
 * `tx.accepted` 不走这里（它有自己的交易码卡）；`tx.proposal` / `tx.rejected`
 * 翻成中文，其余（含普通文本系统消息）按原文。
 */
export function systemPillText(content: string): string {
  const event = parseTxEvent(content)
  if (!event) return content
  if (event.type === 'tx.proposal') return '待对方同意'
  if (event.type === 'tx.rejected') return '卖家已拒绝这次交易'
  return content
}

/** 商品摘要条的状态文案（与「我的发布」同一口径） */
const LISTING_STATUS_LABEL: Record<string, string> = {
  ACTIVE: '在售',
  RESERVED: '已预订',
  SOLD: '已售出',
  OFFLINE: '已下架',
}

export function listingStatusText(status: string | undefined): string {
  if (!status) return '商品已下架'
  return LISTING_STATUS_LABEL[status] ?? status
}

/**
 * 本地乐观消息（正在发送 / 发送失败）。
 *
 * 契约里没有「发送中」，这是纯客户端的临时状态：成功后被服务端返回的那条替换掉
 * （按 id 去重，实时推送送来的同一条也不会重复）。
 */
export type PendingMessage = {
  /** 本地临时 id（只用于渲染 key 与重试定位，不是服务端 id） */
  id: string
  content: string
  status: 'sending' | 'failed'
}

/**
 * 发送失败后是否还能重试同一个临时条目。
 * 组件用它当重试门禁（而不是在组件里再写一遍等价判断）：这样「失败才可重试」
 * 这条规则有测试直接锁在真实调用点上。
 */
export function canRetry(message: PendingMessage): boolean {
  return message.status === 'failed'
}

/**
 * 按契约的 `(createdAt, id)` 升序排。
 *
 * 为什么需要：发送成功是按**响应到达顺序**追加的，连发两条时响应可能乱序回来，
 * 界面上的先后就会与服务端落库顺序（契约的排序键）相反。
 */
export function sortMessages(items: MessageDto[]): MessageDto[] {
  return [...items].sort((a, b) => {
    const at = Date.parse(a.createdAt)
    const bt = Date.parse(b.createdAt)
    if (at !== bt) return at - bt
    if (a.id === b.id) return 0
    return a.id < b.id ? -1 : 1
  })
}

/**
 * 后台刷新（silent）落地时把新快照合并回已有消息流（#186 P2-1）。
 *
 * silent 刷新发起于用户没有请求刷新的时刻，**它带回来的快照可能早于本次刷新期间
 * 才发送成功的那条消息** —— HTTP 响应顺序无法保证：`POST /messages` 先落库并 resolve，
 * 补刷新的 `load({ silent: true })` 后到，手里却是发送之前的快照。此时无条件
 * `setMessages(page.items)` 会把那条已经确认的消息抹掉，用户看到自己刚发出去的话
 * 消失，下一次刷新又冒出来。
 *
 * 合并规则（`baseIds` = 本次刷新**发起时**消息流里的 id 快照）：
 * - 以服务端快照为准：它可能包含对方刚发来的新消息，也可能修正本地顺序；
 * - 额外保留 `baseIds` 之外、且不在快照里的消息 —— 那些是刷新发起**之后**才确认
 *   落地的（本地乐观气泡被服务端返回替换的那一刻）；
 * - 按 id 去重后交给 `sortMessages` 定序，实时推送送来的同一条不会重复。
 */
export function mergeRefreshedMessages(
  previous: MessageDto[],
  incoming: MessageDto[],
  baseIds: ReadonlySet<string>,
): MessageDto[] {
  const seen = new Set(incoming.map((item) => item.id))
  const carried: MessageDto[] = []
  for (const item of previous) {
    if (baseIds.has(item.id) || seen.has(item.id)) continue
    seen.add(item.id)
    carried.push(item)
  }
  return sortMessages([...incoming, ...carried])
}

/**
 * 「加载更早一页」的落定守卫（#186 P2-2）。
 *
 * 更早一页是**账号 + 会话作用域**的快照：发起后若发生换账号、换会话或整页重拉
 * （三者都会 `epoch +1`），这批数据与 `loadingEarlier` 这把锁就都已经属于上一代。
 *
 * `then` 与 `finally` 必须用同一个守卫：前者决定「要不要写入」，后者决定
 * 「要不要还锁」。旧实现只在 `then` 里判过期，`finally` 却无条件
 * `setLoadingEarlier(false)` —— 新账号的分页请求还在飞的时候锁被上一个账号放掉，
 * 第二次点击就能再发一次，同一个 `before` 游标被并发消费两次。
 *
 * 反过来，整页重拉把在途分页判过期后必须**主动**还锁（见页面里 `load` 的
 * `setLoadingEarlier(false)`）：否则那次分页自己的 `finally` 也不会执行，锁永久拿着。
 */
export function isLatestPageLoad(epoch: number, latestEpoch: number): boolean {
  return epoch === latestEpoch
}

/**
 * 会话流里真正按顺序渲染的一条。
 * 服务端消息按 `(createdAt, id)` 升序；本地待发消息永远排在最后（它必然最新）。
 */
export type ChatEntry =
  | { kind: 'message'; keyId: string; message: MessageDto }
  | { kind: 'pending'; keyId: string; pending: PendingMessage }

/**
 * 页面重新显示（`useDidShow`）时要不要**立刻**重拉（#170 D）。
 *
 * 四个条件缺一不可：
 * - `loadedOnce`：首次显示让渡给登录态 effect，didShow 不重复发（冷启动不双发）；
 * - `authed` / `hasUserId`：登录态未就绪 / 未登录时不发受限请求；
 * - `!sending`：有在途发送时重拉会把 epoch +1，在途的发送响应被判过期丢弃，
 *   乐观气泡永远停在「发送中」——这种情况改走延后刷新（见下）。
 *
 * 抽成纯函数是为了它能被单测锁住（页面组件本身没有渲染测试基建）；
 * **组件接线**（是否调用、传什么参数）仍靠 code review + 端上验收。
 */
export function shouldReloadOnShow(input: {
  loadedOnce: boolean
  authed: boolean
  hasUserId: boolean
  sending: boolean
}): boolean {
  return input.loadedOnce && input.authed && input.hasUserId && !input.sending
}

/**
 * 会话详情态。`loading` 是页面自己的在途态；其余三个来自 `loadConversation`
 * （`features/fetchers.ts`：ok / missing / failed）。
 */
export type ConvState = 'loading' | 'ok' | 'missing' | 'failed'
/** `loadConversation` 能返回的详情态（不含页面自己的 `loading`） */
export type ConvDetailStatus = Exclude<ConvState, 'loading'>

/**
 * 后台刷新（silent）如何落详情态：**只做确认、不做降级**。
 *
 * 为什么必须单独判：silent 补刷新发生在「发送落定」之后，而 `loadConversation` 与
 * `loadMessagePage` 是**两个独立请求** —— 弱网下（正是「发送失败」的相关场景）往往
 * 一起失败。若照常把详情态写成 `failed`，渲染会在 `convState !== 'ok'` 处短路成
 * 整页「会话加载失败」，把刚失败的乐观气泡与它的「发送失败 · 重试」一起盖掉 ——
 * 而发送失败本就该留在原地给重试。
 *
 * 但也不能无条件保留：页面**还没正常显示过**（`loading` / `failed`）时必须如实落
 * 详情结果，否则会停在一个没有重试入口的态上（`loading` 分支不渲染重试钮）。
 * 真被删掉的会话，下一次用户主动进页 / 点重试（非 silent）仍会如实反映。
 *
 * 抽成纯函数是因为这条判据是 #170 review 的修复点本身 —— 页面组件没有渲染测试
 * 基建，不抽出来就没有任何用例能在它被改坏时变红（`prev` 必须由调用方经
 * `setConvState` 的函数式更新传入：`load` 的 `useCallback` 依赖只有
 * `[conversationId]`，闭包里的 `convState` 永远停在首帧）。
 */
export function resolveConvState(
  prev: ConvState,
  detail: ConvDetailStatus,
  silent: boolean,
): ConvState {
  if (!silent || detail === 'ok') return detail
  return prev === 'ok' ? 'ok' : detail
}

/**
 * 「发送中返回」延后刷新的状态机（#170 D 的延后分支）。
 *
 * ## 为什么是一个状态而不是几个独立 ref
 *
 * 在途发送计数**必须归属 epoch**。发送是跨账号生命周期的异步操作：A 的发送可能在
 * 换到 B 之后才落定（最长等到 `REQUEST_TIMEOUT_MS`）。若计数是实例级的，A 那次落定
 * 会把 B 的计数也减掉 —— B 的补刷新要么被**永久压制**（B 自己的落定先到、计数没归零），
 * 要么被一次**无来源的陈旧落定**触发（A 的落定恰好是归零的那次），同时 `deferred`
 * 残留下来，之后被 B 任意一次发送落定消费掉，闪一次无来由的整页加载。
 *
 * 把「标记 + 计数 + 计数归属的 epoch」绑成一个状态、迁移只走下面几个函数，
 * 这条不变式就能被单测直接锁住（`inflight === 0` 一定属于当前 epoch 的最后一个发送）。
 */
export type DeferredReload = {
  /** 欠一次刷新：didShow 遇在途发送时置位 */
  deferred: boolean
  /** 当前 epoch 的在途发送数 */
  inflight: number
  /** `inflight` 归属的 epoch */
  epoch: number
}

export function initialDeferredReload(epoch: number): DeferredReload {
  return { deferred: false, inflight: 0, epoch }
}

/** 记下「欠一次刷新」（不立刻发，否则 epoch +1 会把乐观气泡卡在「发送中」） */
export function deferReload(state: DeferredReload): DeferredReload {
  return { ...state, deferred: true }
}

/**
 * 发起一次发送。传入当前 epoch：与状态里的 epoch 不同（换过账号）时，
 * 把旧 epoch 的残留计数整个丢掉、从 1 重新计。
 */
export function beginSend(state: DeferredReload, epoch: number): DeferredReload {
  if (state.epoch !== epoch) return { deferred: state.deferred, inflight: 1, epoch }
  return { ...state, inflight: state.inflight + 1 }
}

/**
 * 一次发送落定（成功 / 失败都走这里）。
 *
 * 陈旧 epoch 的落定**原样返回**：既不计入当前 epoch 的计数，也不会把当前 epoch 的
 * 「已无在途」判成真 —— 这正是「A 的 finally 不能触发 B 的刷新」那道闸。
 */
export function settleSend(state: DeferredReload, epoch: number): DeferredReload {
  if (state.epoch !== epoch) return state
  return { ...state, inflight: Math.max(0, state.inflight - 1) }
}

/** 是否到了补刷新的时刻：还欠着 + 当前 epoch 已无在途发送（多个并发只会在最后一次落定时为真） */
export function isFlushDue(state: DeferredReload): boolean {
  return state.deferred && state.inflight === 0
}

/** 补刷新已发出（或本次返回已由 didShow 正常重拉）：清标记。计数不动 */
export function clearDeferredReload(state: DeferredReload): DeferredReload {
  return { ...state, deferred: false }
}

/** 身份清场：标记与计数一起归到新 epoch，避免上个账号的标记被新账号的落定消费 */
export function resetDeferredReload(epoch: number): DeferredReload {
  return { deferred: false, inflight: 0, epoch }
}

/**
 * 到了补刷新的时刻、且补刷新真的能发：身份有效、页面可见且未卸载。
 *
 * `visible` 为假时**不补也不丢** —— 标记留着，回到本页时 `useDidShow` 会因为
 * 「已无在途发送」走正常重拉，那时一并清掉。
 */
export function shouldFlushDeferredReload(input: {
  state: DeferredReload
  authed: boolean
  hasUserId: boolean
  visible: boolean
}): boolean {
  return isFlushDue(input.state) && input.authed && input.hasUserId && input.visible
}
