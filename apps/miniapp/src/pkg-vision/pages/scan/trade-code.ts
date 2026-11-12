/**
 * 相机页「输入交易码」浮层（#674）的**纯逻辑**：哪笔订单能核销、浮层该显示哪一屏、
 * 失败落哪句话。组件只摆 UI 与调接口，判断全在这里（同目录 `outcome.ts` 的写法）。
 *
 * 为什么要「先选订单再输码」：`POST /transactions/:id/meetup-token/verify-code` 必须带
 * `transactionId`（`apps/api/src/modules/transactions/router.ts:234-249`），6 位码只在
 * 某笔订单的上下文里才成立 —— 所以浮层第一步不是输入框，而是「选一笔待面交的订单」。
 */
import type { TransactionStatus } from '@fish/contracts/transactions/schema'
import type { AuthStatus } from '@/features/auth/store'
import type { FailureKind } from '@/features/load-failure'
import type { OrderCardView } from '@/features/transaction/adapt'
import { MEETUP_CONFIRM_HINT, type MeetupRedeemFailure } from '@/features/transaction/meetup-code'
import { isDemoSource } from '@/features/transaction/order-links'

/**
 * 能核销的订单：**本人买家** · 还在「待面交」· 不是演示 fixture。
 *
 * - 核销方只有买家：卖家核销自己出示的码会拿到 403 `MEETUP_TOKEN_NOT_ALLOWED`；
 * - `COMPLETED` / `CANCELLED` 已终结，码随之失效（同面交页 `statusPill` 的「交易码已失效」）；
 * - 演示 fixture 的 `t-*` 假 id 进真实接口只会 404，判据复用 `isDemoSource`。
 */
export function isRedeemableOrder(item: OrderCardView): boolean {
  return item.role === 'buyer' && item.status === 'PENDING_MEETUP' && !isDemoSource(item)
}

/** 浮层里的可选订单（保持读取顺序：订单接口已按最新在前） */
export function redeemableOrders(items: OrderCardView[]): OrderCardView[] {
  return items.filter(isRedeemableOrder)
}

/** 浮层的一屏：未登录 / 读取中 / 读取失败 / 空 / 选单 / 输码 / 待确认 / 成功 */
export type TradeCodeStage =
  | 'guest'
  | 'loading'
  | 'failed'
  | 'empty'
  | 'orders'
  | 'input'
  | 'confirm'
  | 'done'

/**
 * 浮层该显示哪一屏。
 *
 * 判定顺序是有讲究的（每一条都对应一次审查修正）：
 * - 已落定的结果排最前：`done`、`confirm` 之后不再看登录态 / 读取状态 —— 否则冷启动那一问
 *   的 `anonymous`、重读订单的 `loading` 会把用户手里的确认入口或完成回执换掉（审查 3、5、9）；
 * - `unknown` 与 `loading` 都只是「还在问」，不能提前给「请先登录」（`bootstrapAuth` 在飞）；
 * - 只有 `failure === 'unauthenticated'`（后端 401，权威）才算未登录。`/me` 偶发失败也会把
 *   `authStatus` 写成 `anonymous`（`features/auth/store.ts:106-134`），照它出「去登录」会把
 *   仍有效的会话挡在门外；读取失败一律落到可重试的 `failed`（审查 10）；
 * - 订单读到了就照订单走：一次成功的读取比登录态更可信。
 */
export function tradeCodeStage(state: {
  authStatus: AuthStatus
  loading: boolean
  /** 读单失败的原因（`null` = 没失败）；只有 `'unauthenticated'` 才等于「确实没登录」 */
  failure: FailureKind | null
  /** 已经过滤成可选订单（`redeemableOrders`） */
  orders: OrderCardView[]
  pickedOrderId: string | null
  /** 码已核销、面交确认还没落定（confirm 失败待重试） */
  confirmPending: boolean
  done: boolean
}): TradeCodeStage {
  if (state.done) return 'done'
  if (state.confirmPending && state.pickedOrderId !== null) return 'confirm'
  if (state.authStatus === 'unknown' || state.loading) return 'loading'
  if (state.failure === 'unauthenticated') return 'guest'
  if (state.failure !== null) return 'failed'
  if (state.orders.length === 0) return state.authStatus === 'anonymous' ? 'guest' : 'empty'
  // 选中的订单可能已经不在最新列表里（刚被核销 / 被取消后重读）：退回选单屏，
  // 别把用户停在一笔已经不能核销的单子上。
  return state.orders.some((item) => item.id === state.pickedOrderId) ? 'input' : 'orders'
}

/** 各屏的说明文案（失败屏取 `failureCopy`、成功屏取 `tradeCodeDoneText`，不在这里） */
export const TRADE_CODE_STAGE_TEXT: Record<Exclude<TradeCodeStage, 'failed' | 'done'>, string> = {
  guest: '登录后才能核销交易码。',
  loading: '正在读取你的订单…',
  empty: '暂无可核销的订单：只有「待面交」的买入订单能用交易码核销。',
  orders: '选一笔「待面交」的买入订单，再输入对方出示的 6 位交易码。',
  input: '输入对方「交易码」页面上的 6 位数字。',
  // 「码已核销、确认还差一步」这句与面交页共用同一个常量（`meetup-code`）
  confirm: MEETUP_CONFIRM_HINT,
}

/**
 * 核销成功后的收尾说明：双侧确认齐 = 已完成；只有本侧确认时提醒还差对方一步。
 * 与面交页完成页同口径（那边是整页文案，这边只有一句浮层说明）。
 */
export function tradeCodeDoneText(status: TransactionStatus): string {
  return status === 'COMPLETED'
    ? '本次面交已确认，本单已完成并归档。'
    : '交易码已核销，等对方确认后本单完成。'
}

/**
 * 核销失败 → 浮层行内文案。码错 / 已用 / 锁定 / 未出码 / 网络兜底与面交页共用
 * `meetupRedeemFailure` 那一份；只有面交页靠「重读交易 / 暂不展示」处理的两种落点，
 * 在浮层里需要一句用户读得懂的话（浮层没有整页状态卡可落）。
 */
export function tradeCodeFailureMessage(failure: MeetupRedeemFailure): string {
  switch (failure.kind) {
    case 'terminal':
      return '这笔交易已经结束（已完成或已取消），不能再核销。'
    case 'not-allowed':
      return '这是你自己出示的交易码，不能由你核销。'
    case 'message':
      return failure.message
  }
}

/**
 * confirm 阶段撞上终态（对方刚确认 / 刚取消）：确认入口撤下、退回选单屏时的说明。
 *
 * 与 `tradeCodeFailureMessage` 的 `terminal` 分开写：那一句说的是「码没能用上、不能再核销」，
 * 这里码**已经核销成功**，错的只是最后一步确认，说「不能再核销」会让用户以为码白输了。
 */
export const TRADE_CODE_CONFIRM_TERMINAL = '这笔交易已经结束（已完成或已取消），确认入口已撤下。'

/**
 * 「这枚码此前已经核销成功、只差确认面交」时的说明（#674 审查 2）。
 *
 * 用户重输同一枚码会拿到 409 `MEETUP_TOKEN_CONSUMED`；重读交易后我们知道码确实用掉了，
 * 于是直接把人送到确认屏。这句话必须解释「为什么不用再输码」，否则用户会以为码没生效。
 */
export const TRADE_CODE_NEEDS_CONFIRM = '这枚交易码此前已核销成功，只差「确认面交」这一步。'

/* ---------------------------------------------------------------- 异步回包的「代次」闸门
 * 浮层里的三件异步事（读订单、提交核销、重试确认）都可能跨越「浮层关掉又打开」「账号换了」
 * 「又来了一次读单」而落地。早前它们各自直接 setState：关掉的浮层里的旧回包会把新浮层顶成
 * 旧内容、A 账号读到的订单会显示在 B 账号眼前（#674 审查 1、4、8）。用它统一拦。
 */

/** 一次浮层操作出发时记下的代次。 */
export type OverlayTicket = {
  /** 浮层开 / 关各换一次号：关掉的浮层里飞着的回包一律不落地 */
  session: number
  /** 每次读单换一次号：两次读单重叠时只有最后发出的那次算数 */
  load: number
  /** 发起时登录的是谁：期间换账号（含退出）也不落地 */
  owner: string | null
}

/** 换号：开 / 关浮层调 `'session'`，每次读单调 `'load'`。 */
export function nextTicket(
  ticket: OverlayTicket,
  part: 'session' | 'load',
  owner: string | null,
): OverlayTicket {
  if (part === 'session') return { session: ticket.session + 1, load: ticket.load, owner }
  return { session: ticket.session, load: ticket.load + 1, owner }
}

/**
 * 回包到达时该怎么处置（`'land'` = 可以落 UI）。
 *
 * `tracksLoad`：这次操作会不会被「更新的一次读单」作废 —— 读单传 `true`（重叠读单按发出
 * 顺序取最后一次），提交核销 / 重试确认传 `false`（它们不是读单，不该被随后的重读顶掉，
 * 否则用户刚提交成功的结果会被一次后台刷新抹掉）。
 *
 * 三种否掉的原因要分开，因为善后不一样：`stale-session`（浮层关了又开）与 `superseded`
 * （有更新的读单在飞）都只是**不该动 UI**，状态归新的那一次；`stale-owner`（账号变了）
 * 意味着手里这批数据是**别人的**，必须清掉。
 */
export type OverlayReply = 'land' | 'stale-session' | 'stale-owner' | 'superseded'

export function overlayReply(
  started: OverlayTicket,
  current: OverlayTicket,
  tracksLoad: boolean,
): OverlayReply {
  if (started.session !== current.session) return 'stale-session'
  if (started.owner !== current.owner) return 'stale-owner'
  if (tracksLoad && started.load !== current.load) return 'superseded'
  return 'land'
}

/**
 * 已读到的订单还能不能给当前用户看（#674 审查 1）：只在「确定换了人」时否掉 ——
 * 读取时有账号、现在也有账号、且两个 id 不同。登录态暂时不可知（`viewerId === null`，
 * 例如冷启动 `/me` 网络失败）时照旧显示：那条路已经由 `tradeCodeStage` 的失败屏兜着，
 * 不能顺手把读到的订单也藏掉（那会让浮层莫名变空）。
 */
export function ordersForViewer(loadedFor: string | null, viewerId: string | null): boolean {
  if (loadedFor === null || viewerId === null) return true
  return loadedFor === viewerId
}
