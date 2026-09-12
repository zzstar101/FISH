import { z } from 'zod'
import { ListingStatusSchema } from '../listings/schema'

/** Chat Domain Contract（Issue #9）。前端和 API 只依赖本目录的字段定义。 */

export const messageTypeSchema = z.enum(['TEXT', 'SYSTEM'])
export type MessageType = z.infer<typeof messageTypeSchema>

/** 查看者在会话中的角色。会话严格双人（买家 + 卖家），角色决定未读列与可见性判定。 */
export const conversationRoleSchema = z.enum(['buyer', 'seller'])
export type ConversationRole = z.infer<typeof conversationRoleSchema>

/** 聊天顶部商品卡的最小字段；取值规则与 #6 的商品卡片一致（脏数据不 500）。 */
export const conversationListingSchema = z.object({
  id: z.string(),
  title: z.string(),
  priceCents: z.number().int(),
  status: ListingStatusSchema,
  coverUrl: z.url().nullable(),
})
export type ConversationListing = z.infer<typeof conversationListingSchema>

export const conversationUserSchema = z.object({ id: z.string(), nickname: z.string() })
export type ConversationUser = z.infer<typeof conversationUserSchema>

export const conversationDtoSchema = z.object({
  id: z.string(),
  listingId: z.string(),
  /** 同一会话对买卖双方输出不同的 role，前端据此渲染「我发出的 / 对方发出的」。 */
  role: conversationRoleSchema,
  listing: conversationListingSchema,
  /** 会话对面的用户；SYSTEM 消息没有发送者，但会话必有双方。 */
  counterpart: conversationUserSchema,
  /** 查看者的未读数；调用 read 端点后归 0。 */
  unreadCount: z.number().int().nonnegative(),
  lastMessageAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
})
export type ConversationDto = z.infer<typeof conversationDtoSchema>

export const messageDtoSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  /** SYSTEM 消息可为 null（DB CHECK 只约束 TEXT 必有 sender）。 */
  senderId: z.string().nullable(),
  sender: conversationUserSchema.nullable(),
  type: messageTypeSchema,
  content: z.string(),
  createdAt: z.iso.datetime(),
})
export type MessageDto = z.infer<typeof messageDtoSchema>

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

/** `.strict()`：多余字段直接 422，而不是静默丢弃（与 auth/listings 一致）。 */
export const conversationCreateInputSchema = z.strictObject({ listingId: z.uuid() })
export type ConversationCreateInput = z.infer<typeof conversationCreateInputSchema>

/** P0 只经 HTTP 发 TEXT；SYSTEM 由 #11 的交易流程在服务端写入，不接受客户端提交。 */
export const messageSendInputSchema = z.strictObject({
  content: z.string().trim().min(1, '消息不能为空').max(2000, '消息最多 2000 个字符'),
})
export type MessageSendInput = z.infer<typeof messageSendInputSchema>

export const conversationListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(50).default(20),
})
export type ConversationListQuery = z.infer<typeof conversationListQuerySchema>

export const conversationListResponseSchema = z.object({
  /** 按 lastMessageAt 降序，DB 两个 (role, lastMessageAt) 索引支撑。 */
  items: z.array(conversationDtoSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
})
export type ConversationListResponse = z.infer<typeof conversationListResponseSchema>

export const messageListQuerySchema = z.object({
  /** 游标分页：上一页最早一条消息的 id；缺省从最新一页开始。 */
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
})
export type MessageListQuery = z.infer<typeof messageListQuerySchema>

export const messageListResponseSchema = z.object({
  /** 按 (createdAt, id) 升序返回，与 DB 索引 messages_conversation_id_created_at_id_idx 一致。 */
  items: z.array(messageDtoSchema),
  hasMore: z.boolean(),
  /** 仅 hasMore 为 true 时非空：把它作为下一次请求的 before。 */
  nextCursor: z.string().nullable(),
})
export type MessageListResponse = z.infer<typeof messageListResponseSchema>

// ---------------------------------------------------------------------------
// WebSocket 实时协议（apps/api/src/modules/realtime）
// ---------------------------------------------------------------------------

/** 服务端 → 客户端。消息先落库再推送；离线端重连后用历史端点补齐，推送不保证不重不漏。 */
export const realtimeServerEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message.new'),
    conversationId: z.string(),
    message: messageDtoSchema,
  }),
  z.object({ type: z.literal('pong') }),
])
export type RealtimeServerEvent = z.infer<typeof realtimeServerEventSchema>

/** 客户端 → 服务端。P0 只有保活；typing / 已读回执不在本 Issue 范围。 */
export const realtimeClientEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }),
])
export type RealtimeClientEvent = z.infer<typeof realtimeClientEventSchema>

// ---------------------------------------------------------------------------
// 错误码：本 domain 新增的部分。其余复用 `auth` 的 `UNAUTHENTICATED`（401）
// 与 `system` 的 `VALIDATION_FAILED` / `INTERNAL_ERROR`。
// ---------------------------------------------------------------------------

export const ChatErrorCodeSchema = z.enum([
  /** 404：会话 id 不存在，或查看者不是会话双方（404 而非 403，不泄漏存在性）。 */
  'CONVERSATION_NOT_FOUND',
  /** 404：创建会话时 listingId 不存在。 */
  'LISTING_NOT_FOUND',
  /** 409：买家 = 卖家（与 DB CHECK conversations_buyer_id_differs_from_seller_id 同源）。 */
  'CANNOT_CHAT_WITH_SELF',
])
export type ChatErrorCode = z.infer<typeof ChatErrorCodeSchema>
