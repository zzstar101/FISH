import { messageDtoSchema } from '@fish/contracts/chat/schema'
import { TRANSACTION_ROUTES } from '@fish/contracts/transactions/routes'
import type { TransactionDto, TransactionRole } from '@fish/contracts/transactions/schema'
import {
  transactionDtoSchema,
  transactionListResponseSchema,
} from '@fish/contracts/transactions/schema'
import { apiRequest } from '../../lib/api-client'

function readTransaction(payload: unknown): TransactionDto {
  return transactionDtoSchema.parse(payload)
}

/**
 * 提案/拒绝的响应是**写入会话的 SYSTEM MessageDto**（#11 契约 §路由表），
 * 不是 tx.* 事件本身——事件编码在 message.content 的 JSON 里。按 MessageDto 校验。
 */
function readSystemMessage(payload: unknown) {
  return messageDtoSchema.parse(payload)
}

/** 交易列表（买卖合并或按 role 过滤）。取第一页，游标由契约保留。 */
export async function fetchTransactions(role?: TransactionRole): Promise<TransactionDto[]> {
  const query = new URLSearchParams({ limit: '50' })
  if (role) query.set('role', role)
  const payload = await apiRequest(`${TRANSACTION_ROUTES.base}?${query.toString()}`)
  return transactionListResponseSchema.parse(payload).items
}

export async function fetchTransaction(id: string): Promise<TransactionDto> {
  return readTransaction(await apiRequest(TRANSACTION_ROUTES.detail(id)))
}

/**
 * 买家发起交易确认（第一步，不建交易行）：会话里写入 tx.proposal SYSTEM 消息。
 * 金额随提案带上，P0 用商品挂价（无议价 UI）。
 */
export async function proposeTransaction(conversationId: string, amountCents: number) {
  const payload = await apiRequest(TRANSACTION_ROUTES.proposals, {
    method: 'POST',
    body: JSON.stringify({ conversationId, amountCents }),
  })
  return readSystemMessage(payload)
}

/**
 * 卖家接受提案并创建交易（唯一创建交易行的端点，201 TransactionDto）。
 * 重试收到 409 LISTING_NOT_ACTIVE 时交易可能已在上次成功创建——调用方以
 * 会话内 tx.accepted 消息或交易列表为准，不得把 409 直译成「接受失败」。
 */
export async function acceptTransaction(
  conversationId: string,
  amountCents: number,
): Promise<TransactionDto> {
  const payload = await apiRequest(TRANSACTION_ROUTES.accept, {
    method: 'POST',
    body: JSON.stringify({ conversationId, amountCents }),
  })
  return readTransaction(payload)
}

/** 卖家拒绝提案：会话里写入 tx.rejected SYSTEM 消息（200 MessageDto）。 */
export async function rejectTransaction(conversationId: string) {
  const payload = await apiRequest(TRANSACTION_ROUTES.reject, {
    method: 'POST',
    body: JSON.stringify({ conversationId }),
  })
  return readSystemMessage(payload)
}

/** 双方确认面交（幂等；第二侧确认触发 COMPLETED + listing SOLD）。 */
export async function confirmTransaction(id: string): Promise<TransactionDto> {
  return readTransaction(await apiRequest(TRANSACTION_ROUTES.confirm(id), { method: 'POST' }))
}

/** 取消（PENDING_MEETUP → CANCELLED，listing 恢复 ACTIVE；CANCELLED 上幂等）。 */
export async function cancelTransaction(id: string): Promise<TransactionDto> {
  return readTransaction(await apiRequest(TRANSACTION_ROUTES.cancel(id), { method: 'POST' }))
}
