import type { ConversationDto, MessageDto } from '@fish/contracts/chat/schema'
import type { TransactionDto, TransactionSystemEvent } from '@fish/contracts/transactions/schema'
import { lastTxSignalOf, txEventOfContent } from '@/features/transaction/tx-signal'

/**
 * 会话行的交易进度胶囊（任务一 #89：昵称后随状态变色的胶囊）。
 *
 * 数据源是**交易域本身**，不是 `listing.status`：商品状态是整个商品的（同一商品
 * 可有多个买家的会话），别人成交会让你的会话行误报；交易行才与 (listing, buyer)
 * 会话一一对应。两种来源按优先级合成：
 *
 * 1. `GET /transactions`（买卖双角色各取完）按 `conversationId` 对上的**最新**一笔交易
 *    —— 同意之后的一切状态都在这里（PENDING_MEETUP / COMPLETED / CANCELLED）；
 * 2. 没有交易行时，会话里的**最后一个交易事件**（`tx-signal.ts`，与「我的发布」的
 *    「待确认」段同一份规则）是 `tx.proposal`，说明买家已发提议、卖家未接受
 *    （提案不落 transactions 表，契约冻结的取舍）。提议只由买家发起，`role` 区分措辞。
 *
 * 为什么提案态看「最后一个事件」而不是「最后一条消息」：买家提案之后卖家可能先回句话
 * （TEXT），提案仍在等点头 —— 只看最后一条消息会让胶囊凭空消失（`pending.ts` 文件头
 * 第 1 条同一口径）。`lastMessage` 本身就是 `tx.*` 事件时走短路，不必再拉消息页。
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

/** `conversationId → 该会话最后一个 tx.* 事件`（`null` = 扫过、确认没有） */
export type TxEventIndex = Map<string, TransactionSystemEvent | null>

/**
 * 这一行是否**需要**拉消息页才能判定胶囊：没有交易行、且 `lastMessage` 推不出结论。
 *
 * - 有交易行 → 不需要（状态机只看交易行）；
 * - `lastMessage` 是 `tx.*` 事件 → 不需要（它就是最后一个事件，零成本短路）；
 * - `lastMessage` 为空（会话里一条消息都没有）→ 不需要（确实没有提案）；
 * - 其余（TEXT / MEDIA / 非交易 SYSTEM）→ 需要：买家可能提过案、之后有人回了句话。
 */
export function needsProposalScan(
  conversation: ConversationDto,
  transactions: Map<string, TransactionDto>,
): boolean {
  /*
   * 有交易行就只看交易行 —— **除了已取消**：取消后同一会话可以重新提案（`propose`
   * 只写 SYSTEM 消息、不落表），此时行与提案并存，只认交易行会把「等你点头」显示成
   * 「已取消」。完成态不可能再有新提案（listing 已 SOLD，`propose` 必 409），
   * PENDING_MEETUP 期间 listing 被 RESERVED 锁住、同样提不出案。
   */
  const tx = transactions.get(conversation.id)
  if (tx && tx.status !== 'CANCELLED') return false
  const last = conversation.lastMessage
  if (!last) return false
  if (last.type !== 'SYSTEM') return true
  return txEventOfContent(last.content) === null
}

/** 一页消息 → 该会话最后一个交易事件（`null` = 确实没有）。供页面扫描提案时调用。 */
export function lastEventOfMessages(
  messages: readonly MessageDto[],
): TransactionSystemEvent | null {
  return lastTxSignalOf(messages)?.event ?? null
}

/**
 * 单个会话行的胶囊状态。`null` = 没有交易意向，不显示。
 *
 * `txEvents` 是**已扫描**的提案索引（可缺省）：命中该会话时用它（`null` 也照用，
 * 表示「扫过、没有提案」）；没命中就退回 `lastMessage` —— 退回只对「`lastMessage`
 * 本身就是 `tx.*`」的情形有意义，其余情形调用方应当先扫过。
 */
export function capsuleFor(
  conversation: ConversationDto,
  transactions: Map<string, TransactionDto>,
  txEvents?: TxEventIndex,
): ConversationCapsule | null {
  const tx = transactions.get(conversation.id)
  const event = txEvents?.has(conversation.id)
    ? (txEvents.get(conversation.id) ?? null)
    : lastEventOfLastMessage(conversation)
  /*
   * 已取消的行可以被**后来的**提案盖过：取消把 listing 放回 ACTIVE，同一会话即可
   * 重新提案（`propose` 只写消息、不落表），此时行与提案并存。终态不写 SYSTEM 消息
   * （契约 `transactionSystemEventSchema` 三元），所以「最后一个交易事件是提案」
   * 只可能来自 accepted 之后的新提案 —— 此刻更能回答「现在等我做什么」的是提案。
   *
   * 完成态与 PENDING_MEETUP 不适用：前者商品已 SOLD、后者被 RESERVED 锁住，
   * `propose` 都会 409，不可能再有新提案。
   */
  const proposalSupersedes = tx?.status === 'CANCELLED' && event?.type === 'tx.proposal'
  if (tx && !proposalSupersedes) {
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

  if (event?.type === 'tx.proposal') {
    // 提案只由买家发起：买家视角是「我发的、等对方同意」，卖家视角是「等我先接受」。
    return conversation.role === 'buyer'
      ? { label: '待同意', cls: 'is-pending' }
      : { label: '待接受', cls: 'is-pending' }
  }
  return null
}

/** 会话行摘要能给出的最后一个事件：只有 `lastMessage` 本身就是 `tx.*` 时才知道 */
function lastEventOfLastMessage(conversation: ConversationDto): TransactionSystemEvent | null {
  const last = conversation.lastMessage
  if (last?.type !== 'SYSTEM') return null
  return txEventOfContent(last.content)
}

/**
 * 把买卖两个视角的交易列表合成 `conversationId → 交易` 映射。
 *
 * **同一会话可能有多笔历史交易**：取消后重新接受会再建一笔，两笔共用同一
 * `conversation_id`（`transactions` 的部分唯一索引只约束 PENDING_MEETUP / COMPLETED，
 * CANCELLED 行可累积）。列表按 `created_at DESC` 返回 —— 数组**末尾是最旧的**，
 * 无脑 `map.set` 会让最旧那笔（例如早已取消的）永久盖住当前那笔。所以按
 * `createdAt` 取最新：越新的覆盖越旧的，`createdAt` 相同时后出现的胜（同毫秒属
 * 极端巧合，取哪笔都不影响「当前状态」的正确性）。
 */
export function transactionsByConversation(
  buyer: TransactionDto[],
  seller: TransactionDto[],
): Map<string, TransactionDto> {
  const map = new Map<string, TransactionDto>()
  for (const tx of [...buyer, ...seller]) {
    const current = map.get(tx.conversationId)
    if (!current || Date.parse(tx.createdAt) >= Date.parse(current.createdAt)) {
      map.set(tx.conversationId, tx)
    }
  }
  return map
}
