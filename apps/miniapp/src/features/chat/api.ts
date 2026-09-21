/**
 * 会话域 API（消息列表 / 聊天）。
 *
 * `/conversations` 整条挂在 `requireAuth` 之下，必须登录。
 * 注意 `ConversationDto` 自带 `listing` / `counterpart` / `lastMessage` 三个嵌套对象
 * （服务端组装，避免前端对每个会话再拉一次消息页），所以消息页不需要额外的用户查询接口。
 */
import { CHAT_ROUTES } from '@fish/contracts/chat/routes'
import {
  type ConversationDto,
  conversationDtoSchema,
  conversationListResponseSchema,
  type MessageDto,
  type MessageListResponse,
  messageDtoSchema,
  messageListResponseSchema,
} from '@fish/contracts/chat/schema'
import { NOTIFICATION_ROUTES } from '@fish/contracts/notifications/routes'
import {
  type NotificationDto,
  notificationListResponseSchema,
  notificationUnreadCountSchema,
} from '@fish/contracts/notifications/schema'
import { apiRequest } from '@/lib/request'

/** 契约里 limit 上限 50 */
const CONVERSATION_LIMIT = 50

/** 契约里消息 limit 上限 100：一次拉到上限，再往前靠 `before` 游标翻页 */
const MESSAGE_PAGE_LIMIT = 100

export async function fetchConversations(): Promise<ConversationDto[]> {
  const payload = await apiRequest(CHAT_ROUTES.base, {
    query: { limit: CONVERSATION_LIMIT },
  })
  return conversationListResponseSchema.parse(payload).items
}

/**
 * 会话未读条数和（底栏「消息」红点用）。
 *
 * 契约没有「会话未读总数」端点，只能拉一页 `GET /conversations` 自己求和，取的是
 * 契约上限 50 条。与 Chat 页首屏用同一页数据 —— 先保证「页内角标」与「底栏红点」
 * 同源、不互相打架；会话多于 50 且更早那批里还有未读时会漏计，要根治得让后端补一个
 * unread-count 端点。此前底栏这一项是从 fixture 现算的（#89 的既有债），
 * 于是真实未读与红点毫无关系。
 */
export async function fetchConversationUnreadCount(): Promise<number> {
  const items = await fetchConversations()
  return items.reduce((sum, item) => sum + item.unreadCount, 0)
}

/** 单个会话详情（深链进来时拿对方摘要与商品卡；404 由调用方按「会话不存在」处理） */
export async function fetchConversation(conversationId: string): Promise<ConversationDto> {
  const payload = await apiRequest(CHAT_ROUTES.detail(conversationId))
  return conversationDtoSchema.parse(payload)
}

/**
 * 一页历史消息。契约按 `(createdAt, id)` **升序**返回，`nextCursor` 为 null 表示已到最早。
 *
 * 返回整个响应而不是只返回 items：会话页要「加载更早的消息」就必须拿到游标
 * （契约明确要求前端把 cursor 原样回传，不许解析或构造）。
 */
export async function fetchMessagePage(
  conversationId: string,
  before?: string,
): Promise<MessageListResponse> {
  const payload = await apiRequest(CHAT_ROUTES.messages(conversationId), {
    query: { limit: MESSAGE_PAGE_LIMIT, before },
  })
  return messageListResponseSchema.parse(payload)
}

/** 发一条文本消息（201，响应体 MessageDto） */
export async function sendMessage(conversationId: string, content: string): Promise<MessageDto> {
  const payload = await apiRequest(CHAT_ROUTES.messages(conversationId), {
    method: 'POST',
    body: { content },
  })
  return messageDtoSchema.parse(payload)
}

/** 标记会话已读（把查看者的 last_read_at 推进到当前时刻） */
export async function markConversationRead(conversationId: string): Promise<ConversationDto> {
  const payload = await apiRequest(CHAT_ROUTES.read(conversationId), { method: 'POST' })
  return conversationDtoSchema.parse(payload)
}

/* ------------------------------------------------------------ 通知 */

export async function fetchNotifications(): Promise<NotificationDto[]> {
  const payload = await apiRequest(NOTIFICATION_ROUTES.base, { query: { limit: 50 } })
  return notificationListResponseSchema.parse(payload).items
}

export async function fetchUnreadNotificationCount(): Promise<number> {
  const payload = await apiRequest(NOTIFICATION_ROUTES.unreadCount)
  return notificationUnreadCountSchema.parse(payload).unreadCount
}

/** 标记单条通知已读（幂等：已读再点仍是 200，且不改写首次已读时间） */
export async function markNotificationRead(id: string): Promise<void> {
  await apiRequest(NOTIFICATION_ROUTES.markRead(id), { method: 'POST' })
}
