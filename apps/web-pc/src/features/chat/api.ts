import { CHAT_ROUTES } from '@fish/contracts/chat/routes'
import {
  type ConversationDto,
  type ConversationListResponse,
  conversationDtoSchema,
  conversationListResponseSchema,
  conversationUnreadCountSchema,
  type MessageDto,
  type MessageListResponse,
  type MessageSendInput,
  messageDtoSchema,
  messageListResponseSchema,
} from '@fish/contracts/chat/schema'
import { TRANSACTION_ROUTES } from '@fish/contracts/transactions/routes'
import { ApiError, apiRequest } from '../../lib/api-client'

/** 契约里会话列表 limit 上限 50。 */
export const CONVERSATION_PAGE_LIMIT = 50
/** 契约里消息 limit 上限 100；首次加载取最新一页。 */
export const MESSAGE_PAGE_LIMIT = 100

export function conversationListPath(cursor?: string): string {
  const params = new URLSearchParams()
  params.set('limit', String(CONVERSATION_PAGE_LIMIT))
  if (cursor !== undefined) params.set('cursor', cursor)
  return `${CHAT_ROUTES.base}?${params.toString()}`
}

export function messageListPath(conversationId: string, before?: string): string {
  const params = new URLSearchParams()
  params.set('limit', String(MESSAGE_PAGE_LIMIT))
  if (before !== undefined) params.set('before', before)
  return `${CHAT_ROUTES.messages(conversationId)}?${params.toString()}`
}

/** 一页会话列表；cursor 是服务端下发的不透明字符串，前端只原样回传。 */
export async function fetchConversationPage(cursor?: string): Promise<ConversationListResponse> {
  return conversationListResponseSchema.parse(await apiRequest(conversationListPath(cursor)))
}

/** 创建或复用与商品卖家的会话（201 新建 / 200 复用都返回同一个 ConversationDto）。 */
export async function createConversation(listingId: string): Promise<ConversationDto> {
  return conversationDtoSchema.parse(
    await apiRequest(CHAT_ROUTES.base, {
      method: 'POST',
      body: JSON.stringify({ listingId }),
    }),
  )
}

/** 未读总数独立端点，不受列表分页影响。 */
export async function fetchConversationUnreadCount(): Promise<number> {
  const payload = await apiRequest(CHAT_ROUTES.unreadCount)
  return conversationUnreadCountSchema.parse(payload).unreadCount
}

/**
 * 会话详情。404 统一表示「不存在或当前账号不可访问」，用 null 让页面渲染业务空态，
 * 而不是把可预期状态当成错误页。
 */
export async function fetchConversation(conversationId: string): Promise<ConversationDto | null> {
  try {
    return conversationDtoSchema.parse(await apiRequest(CHAT_ROUTES.detail(conversationId)))
  } catch (error) {
    if (isConversationNotFound(error)) return null
    throw error
  }
}

/** 一页历史消息；契约按 (createdAt, id) 升序返回，before 为上一页最早消息 id。 */
export async function fetchMessagePage(
  conversationId: string,
  before?: string,
): Promise<MessageListResponse> {
  return messageListResponseSchema.parse(await apiRequest(messageListPath(conversationId, before)))
}

/** 发 TEXT 消息；clientRequestId 由调用方为一次新发送生成，重试沿用。 */
export async function sendTextMessage(
  conversationId: string,
  input: MessageSendInput,
): Promise<MessageDto> {
  return messageDtoSchema.parse(
    await apiRequest(CHAT_ROUTES.messages(conversationId), {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  )
}

/** 标记会话已读，响应是同会话的未读归零 DTO。 */
export async function markConversationRead(conversationId: string): Promise<ConversationDto> {
  return conversationDtoSchema.parse(
    await apiRequest(CHAT_ROUTES.read(conversationId), { method: 'POST' }),
  )
}

export function isConversationNotFound(error: unknown): boolean {
  return (
    error instanceof ApiError && error.status === 404 && error.code === 'CONVERSATION_NOT_FOUND'
  )
}

/** 发起会话失败的展示文案；自聊由调用方决定隐藏入口。 */
export function describeCreateConversationFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'LISTING_NOT_FOUND') return '商品不存在或已下架'
  }
  return '发起会话失败，请重试'
}

/** 发送失败的展示文案：只根据契约错误码分支，不把未知错误伪装成成功。 */
export function describeSendFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'IDEMPOTENCY_KEY_REUSED') return '该次发送已用于其它内容'
    if (error.code === 'CONVERSATION_NOT_FOUND') return '会话不存在或不可访问'
    if (error.code === 'VALIDATION_FAILED') return '消息内容不合法'
  }
  return '发送失败，请重试'
}

/**
 * 买家发起交易确认（`POST /transactions/proposals`）：往会话写一条 `tx.proposal` SYSTEM 消息，
 * 响应体就是那条消息，因此和发消息一样走 chat 的消息缓存。
 *
 * 商品仍是 `ACTIVE` —— 提案**不是商品状态**（契约注释同源）：只有卖家接受
 * （`POST /transactions`）才创建交易行并把商品置 `RESERVED`。
 *
 * `amountCents` 是议价结果，随提案带上；接受时以卖家重传的值为准（提案不落库，服务端无处可读）。
 */
export async function proposeTransaction(
  conversationId: string,
  amountCents: number,
): Promise<MessageDto> {
  return messageDtoSchema.parse(
    await apiRequest(TRANSACTION_ROUTES.proposals, {
      method: 'POST',
      body: JSON.stringify({ conversationId, amountCents }),
    }),
  )
}

/**
 * 发起交易确认失败的展示文案。
 *
 * `LISTING_NOT_ACTIVE` 标 `refresh: true`：商品被他人拍下或已下架是**状态漂移**，
 * 页面必须重新取详情，而不是把过期页面留在原地。
 */
export function describeProposeFailure(error: unknown): { message: string; refresh: boolean } {
  if (error instanceof ApiError) {
    if (error.code === 'LISTING_NOT_ACTIVE') {
      return { message: '商品已不在售，可能已被他人拍下', refresh: true }
    }
    if (error.code === 'NOT_CONVERSATION_BUYER') {
      return { message: '只有买家可以发起交易确认', refresh: false }
    }
    if (error.code === 'CONVERSATION_NOT_FOUND') {
      return { message: '会话不存在或不可访问', refresh: false }
    }
    if (error.code === 'VALIDATION_FAILED') {
      return { message: '金额不合法，请核对后重试', refresh: false }
    }
    return { message: error.message, refresh: false }
  }
  return { message: '发起交易确认失败，请重试', refresh: false }
}
