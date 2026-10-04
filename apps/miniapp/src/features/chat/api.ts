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
 * 走专用端点 `GET /conversations/unread-count`（契约 `CHAT_ROUTES.unreadCount`）：
 * 服务端聚合**全部**会话，不受列表 `limit` / 游标翻页影响，与用户有多少会话无关。
 * 与 #23 通知的 `GET /notifications/unread-count` 同款。
 *
 * 此前是对**第一页**（契约上限 50 条）求和，会话多于 50 且更早那批里还有未读时会
 * 漏计 —— 只决定「红点亮不亮」时偏差不可见，改成精确数字后就是用户可见的错误（#291）。
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
 * 创建或复用与商品卖家的会话（`POST /conversations`，响应体 ConversationDto）。
 *
 * 服务端对同一 `(listingId, 买家)` **复用**既有会话：新建 201、复用 200，响应体同型，
 * 所以调用方不必区分、也不必把「已经发起过」记在本地冒充成功 —— 重发本身就是幂等的。
 * 匹配结果页的「聊一聊」用它换到真实 `conversation.id` 再跳会话页（#67 第二步）。
 */
export async function createConversation(listingId: string): Promise<ConversationDto> {
  const payload = await apiRequest(CHAT_ROUTES.base, {
    method: 'POST',
    body: { listingId },
  })
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
 * `replyToId` 是**被引用消息的公开 id**（#359 3c）：带上它就发一条「引用消息」，
 * 服务端在响应与历史里回同一份 `replyTo` 摘引投射。目标不可引用（不存在 / 跨会话 /
 * SYSTEM / 已撤回）→ 422 `MESSAGE_REPLY_INVALID`。
 *
 * 发送体**不带** `type` 判别值：契约里 TEXT 的 `type` 是可选的，而「不带」在
 * 「已升级的 API」与「还没升到 #366 的旧 API」上都合法（旧契约是 strictObject，
 * 多带一个 `type` 反而 422）。小程序发版有审核滞后，这条差异是真实存在的窗口。
 */
export async function sendMessage(
  conversationId: string,
  content: string,
  replyToId?: string,
): Promise<MessageDto> {
  const payload = await apiRequest(CHAT_ROUTES.messages(conversationId), {
    method: 'POST',
    body: { content, replyToId },
  })
  return messageDtoSchema.parse(payload)
}

/**
 * 撤回自己发的一条消息（#359 3c；204 无响应体）。
 *
 * `messageId` 是**公开 id**。窗口 `MESSAGE_RECALL_WINDOW_MS`（2 分钟）内、仅发送者本人；
 * 对已撤回消息幂等（重复调用同样 204）。失败三档：404 `MESSAGE_NOT_FOUND`、
 * 403 `MESSAGE_RECALL_FORBIDDEN`、409 `MESSAGE_RECALL_WINDOW_EXCEEDED`。
 */
export async function recallMessage(conversationId: string, messageId: string): Promise<void> {
  await apiRequest(CHAT_ROUTES.recall(conversationId, messageId), { method: 'POST' })
}

/**
 * 创建一条图片媒体消息（201，响应体 `MediaMessageDto`）。
 *
 * 媒体**刻意不并进 `MessageDto`**（契约文件顶部注释）：它是独立 DTO、独立端点、独立实时
 * 事件。`clientRequestId` 是 #67 幂等键，语义同文本消息：新发送生成、重试沿用同一个。
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

/** 创建一条语音媒体消息（同 `createImageMessage`，`durationMs` 由服务端按字节重解析）。 */
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

/**
 * 发一张商品卡消息（#359；201，响应体 MessageDto）。
 *
 * `listingId` 是被分享商品的公开 id；可渲染的卡片数据由响应里的 `listing` 投射携带
 * （服务端富化，与会话头商品卡同源）。商品不存在或非在售 → 404 LISTING_NOT_FOUND。
 *
 * `clientRequestId` 是**必填**的幂等键（`@/lib/uuid` 的 `randomUuidV4`）：
 * 服务端以 `(senderId, conversationId, clientRequestId)` 去重，同键同商品重放既有那条，
 * 同键换商品才 409 `IDEMPOTENCY_KEY_REUSED`。**重试必须复用同一个键**，否则超时重试会
 * 真落两张卡（见 `pages/send-listing` 的 `sendKeyFor`）。
 */
export async function sendListingMessage(
  conversationId: string,
  listingId: string,
  clientRequestId: string,
): Promise<MessageDto> {
  const payload = await apiRequest(CHAT_ROUTES.messages(conversationId), {
    method: 'POST',
    body: { type: 'LISTING', listingId, clientRequestId },
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
