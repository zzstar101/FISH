import type { ConversationDto } from '@fish/contracts/chat/schema'
import {
  type TransactionDto,
  type TransactionSystemEvent,
  transactionSystemEventSchema,
} from '@fish/contracts/transactions/schema'

/**
 * 会话行的交易进度胶囊（任务一 #89：昵称后随状态变色的胶囊）。
 *
 * 数据源是**交易域本身**，不是 `listing.status`：商品状态是整个商品的（同一商品
 * 可有多个买家的会话），别人成交会让你的会话行误报；交易行才与 (listing, buyer)
 * 会话一一对应。两种来源按优先级合成：
 *
 * 1. `GET /transactions`（买卖双角色各取完）按 `conversationId` 对上的交易行 ——
 *    同意之后的一切状态都在这里（PENDING_MEETUP / COMPLETED / CANCELLED）；
 * 2. 没有交易行时，会话行的 `lastMessage` 若是 `tx.proposal` SYSTEM 消息，说明
 *    买家已发提议、卖家未接受（提案不落 transactions 表，契约冻结的取舍）。
 *    提议只由买家发起，`role` 即区分两边的措辞。
 *
 * `lastMessage` 不是 `tx.proposal`（TEXT 闲聊、`tx.accepted` / `tx.rejected` 终局）
 * 且没有交易行 → 不显示胶囊：提议已被回应或会话里没有交易意向。
 *
 * **配色**（Owner 2026-09-29 端上定版，基于 1版稿 `（已实现）小程序1版messages.html`
 * 的 `.cname .st` 再调）：刻意**不复用**订单页的 `status-pill` mixin —— 那一套是实心
 * 深底（`--brand-deep` / `--muted-2`），本页要的是浅底彩字；用订单页那套会把「已完成」
 * 画成深色实心胶囊（Owner 端上指出「已完成不是黑色的」）。四档：
 * 绿 = 已完成、黄 = 待面交、蓝 = 等对方/待同意、浅底灰 = 已取消。
 */

/**
 * 胶囊视觉档（四档，Owner 2026-09-29 端上定版）：
 * - `is-ok`：绿 —— 已完成（稿里 `.st.done` 是浅底，Owner 改为绿色系）；
 * - `is-warn`：黄 —— 待面交（还没动手面交，最需要被看见的一档）；
 * - `is-pending`：品牌蓝浅底 —— 提议待回应（待同意 / 待接受）、我已确认、等对方；
 * - `is-plain`：极浅底 + 灰字 —— 已取消（唯一「不用做任何事」的终态）。
 */
export type ConversationCapsule = {
  label: string
  cls: 'is-ok' | 'is-warn' | 'is-pending' | 'is-plain'
}

/** SYSTEM 消息 content 里的 `tx.*` 事件；解析失败按无事件处理（优雅降级，与聊天同口径） */
export function parseTxSystemEvent(content: string): TransactionSystemEvent | null {
  try {
    const parsed: unknown = JSON.parse(content)
    const result = transactionSystemEventSchema.safeParse(parsed)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

/** 单个会话行的胶囊状态。`null` = 没有交易意向，不显示。 */
export function capsuleFor(
  conversation: ConversationDto,
  transactions: Map<string, TransactionDto>,
): ConversationCapsule | null {
  const tx = transactions.get(conversation.id)
  if (tx) {
    // 终态：完成走绿、取消走浅底灰字（唯一不用做任何事的一档）。
    if (tx.status === 'COMPLETED') return { label: '已完成', cls: 'is-ok' }
    if (tx.status === 'CANCELLED') return { label: '已取消', cls: 'is-plain' }
    /**
     * PENDING_MEETUP：还没面交 → 「待面交」（黄，最需要被看见）；我已确认、
     * 在等对方点确认 → 「待对方确认」（蓝）。两档同屏时颜色即「等我 / 等对方」的分界。
     */
    const myConfirmedAt = tx.role === 'buyer' ? tx.buyerConfirmedAt : tx.sellerConfirmedAt
    return myConfirmedAt === null
      ? { label: '待面交', cls: 'is-warn' }
      : { label: '待对方确认', cls: 'is-pending' }
  }
  if (conversation.lastMessage?.type === 'SYSTEM') {
    const event = parseTxSystemEvent(conversation.lastMessage.content)
    if (event?.type === 'tx.proposal') {
      // 提案只由买家发起：买家视角是「我发的、等对方同意」，卖家视角是「等我先接受」。
      return conversation.role === 'buyer'
        ? { label: '待同意', cls: 'is-pending' }
        : { label: '待接受', cls: 'is-pending' }
    }
  }
  return null
}

/**
 * 把买卖两个视角的交易列表合成 `conversationId → 交易` 映射。
 * 同一交易按查看者只会出现在一个角色列表里，不存在去重问题。
 */
export function transactionsByConversation(
  buyer: TransactionDto[],
  seller: TransactionDto[],
): Map<string, TransactionDto> {
  const map = new Map<string, TransactionDto>()
  for (const tx of buyer) map.set(tx.conversationId, tx)
  for (const tx of seller) map.set(tx.conversationId, tx)
  return map
}
