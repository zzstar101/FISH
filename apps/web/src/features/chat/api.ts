import { CHAT_ROUTES } from '@fish/contracts/chat/routes'
import type {
  ConversationCreateInput,
  ConversationDto,
  MessageDto,
} from '@fish/contracts/chat/schema'
import {
  conversationDtoSchema,
  conversationListResponseSchema,
  messageDtoSchema,
  messageListResponseSchema,
} from '@fish/contracts/chat/schema'
import { apiRequest } from '../../lib/api-client'

function readConversation(payload: unknown): ConversationDto {
  return conversationDtoSchema.parse(payload)
}

function readMessage(payload: unknown): MessageDto {
  return messageDtoSchema.parse(payload)
}

/** 创建 / 复用会话（「我想要」「聊一聊」唯一入口）：新建 201、复用 200，响应体同构。 */
export async function createConversation(input: ConversationCreateInput): Promise<string> {
  const payload = await apiRequest(CHAT_ROUTES.base, {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return readConversation(payload).id
}

/**
 * 会话列表：买卖两种角色合并，按 lastMessageAt 降序。取第一页（limit 上限 50）。
 * P0 会话量在 demo 规模内，不做滚动分页——下一页游标由契约保留，UI 需要时再接。
 */
export async function fetchConversations(): Promise<ConversationDto[]> {
  const payload = await apiRequest(`${CHAT_ROUTES.base}?limit=50`)
  return conversationListResponseSchema.parse(payload).items
}

/** 历史消息（升序）。`before` 缺省从最新一页开始；重连恢复也走本端点。 */
export async function fetchMessages(conversationId: string): Promise<MessageDto[]> {
  const payload = await apiRequest(`${CHAT_ROUTES.messages(conversationId)}?limit=100`)
  return messageListResponseSchema.parse(payload).items
}

/** 发送 TEXT 消息（201，返回落库后的 MessageDto，本地立即插入渲染）。 */
export async function sendMessage(conversationId: string, content: string): Promise<MessageDto> {
  const payload = await apiRequest(CHAT_ROUTES.messages(conversationId), {
    method: 'POST',
    body: JSON.stringify({ content }),
  })
  return readMessage(payload)
}

/** 标记已读：把查看者的 last_read_at 推进到当前时刻（幂等）。 */
export async function markConversationRead(conversationId: string): Promise<void> {
  await apiRequest(CHAT_ROUTES.read(conversationId), { method: 'POST' })
}
