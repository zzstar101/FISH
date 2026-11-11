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
import type { OrderCardView } from '@/features/transaction/adapt'
import type { MeetupRedeemFailure } from '@/features/transaction/meetup-code'
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

/** 浮层的一屏：未登录 / 读取中 / 读取失败 / 空 / 选单 / 输码 / 成功 */
export type TradeCodeStage = 'guest' | 'loading' | 'failed' | 'empty' | 'orders' | 'input' | 'done'

/**
 * 浮层该显示哪一屏。判定顺序：登录态 → 成功 → 在途 → 失败 → 空 → 选单 / 输码。
 *
 * `authStatus === 'unknown'` 只是登录态还没解析完（冷启动 `bootstrapAuth` 在飞），
 * **不能**当成未登录 —— 否则会先闪一句「请先登录」再跳回来。
 */
export function tradeCodeStage(state: {
  authStatus: AuthStatus
  loading: boolean
  failed: boolean
  /** 已经过滤成可选订单（`redeemableOrders`） */
  orders: OrderCardView[]
  pickedOrderId: string | null
  done: boolean
}): TradeCodeStage {
  if (state.authStatus === 'unknown') return 'loading'
  if (state.authStatus === 'anonymous') return 'guest'
  if (state.done) return 'done'
  if (state.loading) return 'loading'
  if (state.failed) return 'failed'
  if (state.orders.length === 0) return 'empty'
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
