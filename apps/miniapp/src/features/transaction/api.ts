/**
 * 交易域 API（#114 与 #70 的联调层）。
 *
 * `/transactions` 整条挂在 `requireAuth` 之下，必须登录。面交码（meetup token）
 * 的路径常量与响应形状都冻结在 `@fish/contracts/transactions`：
 * - 取码是**卖家**的端点（#176 起幂等「确保并读取」：同一笔交易恒返回**同一枚**
 *   明文码与 qrPayload，重复调用不换码、不改 `issuedAt`，只清零失败计数与锁定；
 *   买家调用 403）；
 * - 核销是**买家**的端点（redeem 出示 QR token / verify-code 出示 6 位码），
 *   成功响应的 `nextAction` 固定为 `CONFIRM_DELIVERY` —— 由客户端接着调 confirm；
 * - 扫码页交付的 QR 原文由契约包 `meetup-qr` 解析（transactionId + token），
 *   meetup 页据此调 redeem；6 位码只在面交页输入，走 verify-code。
 */

import { type MessageDto, messageDtoSchema } from '@fish/contracts/chat/schema'
import { TRANSACTION_ROUTES } from '@fish/contracts/transactions/routes'
import {
  type MeetupTokenResponse,
  type MeetupTokenStatusResponse,
  type MeetupVerificationResponse,
  meetupTokenResponseSchema,
  meetupTokenStatusResponseSchema,
  meetupVerificationResponseSchema,
  type TransactionDto,
  type TransactionListResponse,
  type TransactionRole,
  transactionDtoSchema,
  transactionListResponseSchema,
} from '@fish/contracts/transactions/schema'
import { apiRequest } from '@/lib/request'

/** 列表单页上限。契约 `transactionListQuerySchema.limit` 的上限是 50，超了被 422 拒掉。 */
const PAGE_SIZE = 50

/**
 * 翻页硬上限。契约刻意不给 `total` / `hasMore`（见 `transactionListQuerySchema` 的说明），
 * 所以订单页的「共 N 笔」与筛选计数只能靠**把整份列表取完**才算得准；这个上限只用来兜住
 * 「服务端一直回同一个 cursor」这类 bug，不让页面卡在无限循环里（正常用户的交易量远小于它）。
 */
const MAX_PAGES = 10

export type TransactionListPage = {
  items: TransactionDto[]
  /**
   * 列表**不完整**。两种成因：翻页到 `MAX_PAGES` 上限，或服务端游标没有前进（见下）。
   * 调用方不能拿它的长度当总数 —— 页面据此不显示由总数派生的那几处文案。
   */
  truncated: boolean
}

/** 取一页交易（游标分页）。`cursor` 是不透明串，只能原样回传上一页的 `nextCursor`。 */
export async function fetchTransactions(
  args: { role?: TransactionRole; cursor?: string } = {},
): Promise<TransactionListResponse> {
  const payload = await apiRequest(TRANSACTION_ROUTES.base, {
    query: { role: args.role, limit: PAGE_SIZE, cursor: args.cursor },
  })
  return transactionListResponseSchema.parse(payload)
}

/**
 * 取完某个视角下的全部交易（游标翻页）。
 *
 * 为什么一次取完而不是做无限滚动：订单页的统计行、筛选胶囊计数、区块标题与「已经到底了」
 * 全是**派生值**，只有拿到完整集合才诚实。契约没有 `total`，服务端的 `status` 只能单值过滤，
 * 所以「分四次请求去凑计数」反而更糟（四次请求之间还会出现自相矛盾的中间态）。
 */
export async function fetchAllTransactions(role: TransactionRole): Promise<TransactionListPage> {
  const items: TransactionDto[] = []
  let cursor: string | undefined

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await fetchTransactions({ role, cursor })
    const next = result.nextCursor

    // 游标没前进 = 服务端在重复给同一页。此时**不能收下这一页**：它与上一页是同一批数据，
    // 收下会让列表翻倍、`key` 重复，还会让 `truncated: false` 把「重复的完整」当成真的完整。
    // 按「列表不完整」返回，页面就不会拿它的长度当总数（`MAX_PAGES` 耗尽那条路径同理）。
    if (next !== null && next === cursor) return { items, truncated: true }

    items.push(...result.items)
    if (next === null) return { items, truncated: false }
    cursor = next
  }

  return { items, truncated: true }
}

export async function fetchTransaction(id: string): Promise<TransactionDto> {
  const payload = await apiRequest(TRANSACTION_ROUTES.detail(id))
  return transactionDtoSchema.parse(payload)
}

/**
 * 卖家取码（#176 起是幂等「确保并读取」）：同一笔交易恒返回同一枚 `code` / `qrPayload`，
 * 重复调用**不换码**、不改 `issuedAt`；每次调用清零失败计数与锁定（卖家专属的解锁路径，
 * 码值不变）。买家调用仍 403 `MEETUP_TOKEN_NOT_ALLOWED`。
 */
export async function issueMeetupToken(id: string): Promise<MeetupTokenResponse> {
  const payload = await apiRequest(TRANSACTION_ROUTES.issueMeetupToken(id), { method: 'POST' })
  return meetupTokenResponseSchema.parse(payload)
}

/** 当前面交凭证状态（无明文；NONE 表示还没有取过码）。 */
export async function fetchMeetupTokenStatus(id: string): Promise<MeetupTokenStatusResponse> {
  const payload = await apiRequest(TRANSACTION_ROUTES.meetupTokenStatus(id))
  return meetupTokenStatusResponseSchema.parse(payload)
}

/** 买家出示二维码核销（qrToken 是 payload `t` 参数的原始 token）。 */
export async function redeemMeetupToken(
  id: string,
  qrToken: string,
): Promise<MeetupVerificationResponse> {
  const payload = await apiRequest(TRANSACTION_ROUTES.redeemMeetupToken(id), {
    method: 'POST',
    body: { qrToken },
  })
  return meetupVerificationResponseSchema.parse(payload)
}

/** 买家手动输入 6 位码核销。 */
export async function verifyMeetupCode(
  id: string,
  code: string,
): Promise<MeetupVerificationResponse> {
  const payload = await apiRequest(TRANSACTION_ROUTES.verifyMeetupCode(id), {
    method: 'POST',
    body: { code },
  })
  return meetupVerificationResponseSchema.parse(payload)
}

/** 双方确认面交（核销成功后的 nextAction；幂等，第二侧确认触发 COMPLETED + 商品 SOLD）。 */
export async function confirmTransaction(id: string): Promise<TransactionDto> {
  const payload = await apiRequest(TRANSACTION_ROUTES.confirm(id), { method: 'POST' })
  return transactionDtoSchema.parse(payload)
}

/*
 * ---- 卖家对买家提案的回应（「我的发布」的待确认行用；Web 会话页同一对端点） ----
 *
 * 这一对端点的**响应形状不同**，必须分别在解析处收口：
 * 拒绝只往会话写一条 `tx.rejected` SYSTEM 消息，响应体是 `MessageDto`；
 * 接受是唯一创建交易行的端点，响应体是 `TransactionDto`。
 *
 * 两者的响应都**不是**商品状态：商品在提案阶段一直是 `ACTIVE`（`propose` 不落表、不改商品），
 * 由**接受**这一步把它置 `RESERVED`。所以调用方拿到的结论要按这个顺序读：拒绝之后这件商品
 * 仍在售；接受之后才进「待面交」。
 */

/** 卖家拒绝提案（`POST /transactions/proposals/reject`）：会话里写入 `tx.rejected` SYSTEM 消息。 */
export async function rejectProposal(conversationId: string): Promise<MessageDto> {
  const payload = await apiRequest(TRANSACTION_ROUTES.reject, {
    method: 'POST',
    body: { conversationId },
  })
  return messageDtoSchema.parse(payload)
}

/**
 * 卖家接受提案并创建交易（`POST /transactions`，201 `TransactionDto`）。
 *
 * `amountCents` 必须由调用方把**提案那条消息里的金额**原样带回来：提案不落库，
 * 服务端无处可读（契约 `transactionAcceptInputSchema` 的注释）。
 *
 * 重试口径（契约冻结，别按直觉改成幂等）：响应丢失后重试可能收到 409
 * `LISTING_NOT_ACTIVE` —— 那是「商品已不是 ACTIVE」（并发买家赢了 / 已接受过），
 * 不代表这次操作失败，调用方应以会话内 `tx.accepted` 或订单列表为准。
 */
export async function acceptTransaction(
  conversationId: string,
  amountCents: number,
): Promise<TransactionDto> {
  const payload = await apiRequest(TRANSACTION_ROUTES.accept, {
    method: 'POST',
    body: { conversationId, amountCents },
  })
  return transactionDtoSchema.parse(payload)
}
