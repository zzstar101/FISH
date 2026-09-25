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
  type ConversationListResponse,
  conversationDtoSchema,
  conversationListResponseSchema,
  conversationUnreadCountSchema,
  type ImageMediaMessageInput,
  type MediaMessageDto,
  type MessageDto,
  type MessageListResponse,
  mediaMessageDtoSchema,
  messageDtoSchema,
  messageListResponseSchema,
  type VoiceMediaMessageInput,
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

/**
 * 一页会话列表。`cursor` 传上一页的 `nextCursor`（不透明字符串，只能原样回传）。
 * 返回整个响应：Chat 页要「加载更多」就必须拿到游标。
 */
export async function fetchConversationPage(cursor?: string): Promise<ConversationListResponse> {
  const payload = await apiRequest(CHAT_ROUTES.base, {
    query: { limit: CONVERSATION_LIMIT, cursor },
  })
  return conversationListResponseSchema.parse(payload)
}

/** 会话列表首屏（只要 items 的调用方用这个） */
export async function fetchConversations(): Promise<ConversationDto[]> {
  return (await fetchConversationPage()).items
}

/**
 * 会话未读条数和（底栏「消息」红点用）。
 *
 * 走服务端聚合的 `GET /conversations/unread-count`（#67）。此前是对**第一页**
 * 会话（契约上限 50 条）求和，会话多于 50 且更早那批里还有未读时会漏计 ——
 * 底栏那颗点只为一个数字，不该受列表分页影响。
 *
 * 请求失败时**照常抛出**，由 `features/chat/unread` 记成「不知道」（`null`）：
 * 一个没读到的总数不能被当成 0，那会把「还有未读」误判成「没有未读」。
 */
export async function fetchConversationUnreadCount(): Promise<number> {
  const payload = await apiRequest(CHAT_ROUTES.unreadCount)
  return conversationUnreadCountSchema.parse(payload).unreadCount
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

/**
 * 发一条文本消息（201，响应体 MessageDto）。
 *
 * `clientRequestId`（#67 第一步的客户端一半）：每次**新发送**生成一个 uuid，重试同一条
 * 消息必须沿用同一个 —— 服务端按 `(sender, conversation, clientRequestId)` 建唯一索引，
 * 收到重复请求直接返回已创建的那条，所以「响应丢了再点重试」不会在库里留下第二条。
 * 之前小程序端一直没带这个字段，验收①的小程序路径实际走不通。
 */
export async function sendMessage(
  conversationId: string,
  content: string,
  clientRequestId: string,
): Promise<MessageDto> {
  const payload = await apiRequest(CHAT_ROUTES.messages(conversationId), {
    method: 'POST',
    body: { content, clientRequestId },
  })
  return messageDtoSchema.parse(payload)
}

/**
 * 创建图片 / 语音消息（201，响应体 MediaMessageDto）。
 *
 * 媒体走**独立 DTO**（不扩展 `MessageDto`），且字节先经 `features/chat/media-api.ts`
 * 直传对象存储拿到 `objectKey`，这里只把声明值交给服务端复核。
 * 幂等语义与文本完全一致：同一个 `clientRequestId` 重试返回同一条媒体。
 */
export async function createImageMessage(
  conversationId: string,
  input: Omit<ImageMediaMessageInput, 'kind'>,
): Promise<MediaMessageDto> {
  const payload = await apiRequest(CHAT_ROUTES.media(conversationId), {
    method: 'POST',
    body: { kind: 'IMAGE', ...input },
  })
  return mediaMessageDtoSchema.parse(payload)
}

export async function createVoiceMessage(
  conversationId: string,
  input: Omit<VoiceMediaMessageInput, 'kind'>,
): Promise<MediaMessageDto> {
  const payload = await apiRequest(CHAT_ROUTES.media(conversationId), {
    method: 'POST',
    body: { kind: 'VOICE', ...input },
  })
  return mediaMessageDtoSchema.parse(payload)
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
