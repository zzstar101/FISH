import { z } from 'zod'
import { ListingStatusSchema } from '../listings/schema'

/** Chat Domain Contract（Issue #9）。前端和 API 只依赖本目录的字段定义。 */

export const messageTypeSchema = z.enum(['TEXT', 'SYSTEM'])
export type MessageType = z.infer<typeof messageTypeSchema>

/** #67 媒体消息不扩展旧 MessageDto，避免破坏现有文本/交易消息链路。 */
export const mediaKindSchema = z.enum(['IMAGE', 'VOICE'])
export const MEDIA_MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MEDIA_MAX_VOICE_BYTES = 10 * 1024 * 1024
export const MEDIA_MAX_VOICE_DURATION_MS = 60_000
export const MEDIA_MAX_IMAGE_DIMENSION = 4096
export const MEDIA_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const
// B1 服务端解析真实时长：仅支持可解析容器的 WebM/MP4；MP3 无可靠容器时长，从白名单移除。
export const MEDIA_VOICE_MIME = ['audio/webm', 'audio/mp4'] as const
export type MediaKind = z.infer<typeof mediaKindSchema>

export const mediaPresignInputSchema = z.strictObject({
  kind: mediaKindSchema,
  contentType: z.string().min(1),
  // 上限按 kind 在 service 里再收一次；这里用全局最大（VOICE）做 schema 级硬上限，
  // 与服务端的 `stat.size` 复核形成 defense in depth（评审 blocker 1）。
  sizeBytes: z.number().int().positive().max(MEDIA_MAX_VOICE_BYTES),
})
export type MediaPresignInput = z.infer<typeof mediaPresignInputSchema>

export const mediaPresignResponseSchema = z.strictObject({
  uploadUrl: z.url(),
  objectKey: z.string().min(1),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
})
export type MediaPresignResponse = z.infer<typeof mediaPresignResponseSchema>

export const imageMediaMessageInputSchema = z.strictObject({
  kind: z.literal('IMAGE'),
  objectKey: z.string().min(1),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().positive().max(MEDIA_MAX_IMAGE_BYTES),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** #67 发送幂等键；语义同 `messageSendInputSchema.clientRequestId`。 */
  clientRequestId: z.uuid().optional(),
})
export type ImageMediaMessageInput = z.infer<typeof imageMediaMessageInputSchema>

export const voiceMediaMessageInputSchema = z.strictObject({
  kind: z.literal('VOICE'),
  objectKey: z.string().min(1),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().positive().max(MEDIA_MAX_VOICE_BYTES),
  durationMs: z.number().int().positive(),
  /** #67 发送幂等键；语义同 `messageSendInputSchema.clientRequestId`。 */
  clientRequestId: z.uuid().optional(),
})
export type VoiceMediaMessageInput = z.infer<typeof voiceMediaMessageInputSchema>

export const mediaMessageInputSchema = z.discriminatedUnion('kind', [
  imageMediaMessageInputSchema,
  voiceMediaMessageInputSchema,
])
export type MediaMessageInput = z.infer<typeof mediaMessageInputSchema>

export const mediaMessageDtoSchema = z.strictObject({
  id: z.uuid(),
  conversationId: z.uuid(),
  senderId: z.uuid(),
  kind: mediaKindSchema,
  mediaId: z.uuid(),
  url: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  durationMs: z.number().int().positive().nullable(),
  createdAt: z.iso.datetime(),
})
export type MediaMessageDto = z.infer<typeof mediaMessageDtoSchema>

/**
 * 媒体历史查询（`GET /conversations/:id/media`）。
 * `cursor` 与列表其他接口一致：不透明字符串，前端只原样回传（不得解析或构造）。
 */
export const mediaListQuerySchema = z.object({
  /** 上一页返回的 `nextCursor`；缺省从最新一页开始。 */
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export type MediaListQuery = z.infer<typeof mediaListQuerySchema>

export const mediaListResponseSchema = z.strictObject({
  items: z.array(mediaMessageDtoSchema),
  nextCursor: z.string().nullable(),
})
export type MediaListResponse = z.infer<typeof mediaListResponseSchema>

/** #67 独立媒体实时事件；不并入旧 realtimeServerEventSchema，兼容未接入媒体的客户端。 */
export const mediaRealtimeEventSchema = z.strictObject({
  type: z.literal('media.new'),
  conversationId: z.uuid(),
  media: mediaMessageDtoSchema,
})
export type MediaRealtimeEvent = z.infer<typeof mediaRealtimeEventSchema>

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

export const conversationUserSchema = z.object({
  id: z.string(),
  nickname: z.string(),
  /** users.avatar_url 可空（DB 同款）；聊天列表/详情的头像位需要它，冻结前与前端确认。 */
  avatarUrl: z.url().nullable(),
})
export type ConversationUser = z.infer<typeof conversationUserSchema>

/**
 * 会话行内直接可渲染的「最后一条消息」摘要，由服务端组装——前端拿它渲染列表行，
 * 不必对每个会话再拉一次消息页（N+1）。content 是原文：TEXT 即文本，
 * SYSTEM 为 `tx.*` JSON 原文，由前端按既有解析规则处理。
 */
export const conversationLastMessageSchema = z.object({
  type: messageTypeSchema,
  content: z.string(),
  /** SYSTEM 消息没有发送者；与 MessageDto.senderId 同口径。 */
  senderId: z.string().nullable(),
  createdAt: z.iso.datetime(),
})
export type ConversationLastMessage = z.infer<typeof conversationLastMessageSchema>

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
  /**
   * **对方那一侧**的 `last_read_at`（ISO；对方从未读过为 null）。
   *
   * 不复用 `unreadCount`：它只表达「我」的未读，推不出对方读到了哪一条。
   * 查看者据此渲染自己消息的「已读」：`message.createdAt <= counterpartLastReadAt`
   * 即对方已读到该条（服务端 read 端点推进的是**读写者自己**那一侧，两者的
   * `last_read_at` 是 conversations 表的两个独立列）。
   */
  counterpartLastReadAt: z.iso.datetime().nullable(),
  /** 最新一条消息；会话刚建立还没有任何消息时为 null（此时行内渲染占位文案）。 */
  lastMessage: conversationLastMessageSchema.nullable(),
  lastMessageAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
})
export type ConversationDto = z.infer<typeof conversationDtoSchema>

export const messageDtoSchema = z
  .object({
    id: z.string(),
    conversationId: z.string(),
    /** SYSTEM 消息可为 null；TEXT 必有（DB CHECK messages_text_requires_sender 同源收紧）。 */
    senderId: z.string().nullable(),
    sender: conversationUserSchema.nullable(),
    type: messageTypeSchema,
    content: z.string(),
    createdAt: z.iso.datetime(),
  })
  // DB 的 CHECK 只保证「TEXT ⟹ sender_id 非空」；这里同步收紧到联合完整性，
  // 实现 bug 把违约行发出去时在此炸掉，而不是把残缺 DTO 交给前端。
  .refine((m) => m.type === 'SYSTEM' || (m.senderId !== null && m.sender !== null), {
    path: ['senderId'],
    error: 'TEXT 消息必须有发送者',
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
  /**
   * #67 发送幂等键：客户端为「一次新发送」生成的 UUID，重试同一条消息时**沿用同一个值**。
   *
   * 服务端以 `(senderId, conversationId, clientRequestId)` 唯一约束去重：命中同键且内容
   * 指纹一致 → 返回已创建的消息；同键但内容不同 → 409 `IDEMPOTENCY_KEY_REUSED`。
   *
   * 可选是为了不打断尚未升级的旧客户端：缺省时退化为非幂等发送（与升级前行为一致）。
   * 新客户端必须始终携带。
   */
  clientRequestId: z.uuid().optional(),
})
export type MessageSendInput = z.infer<typeof messageSendInputSchema>

export const conversationListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /**
   * 不透明字符串：服务端对 `(lastMessageAt, id)` 编码，前端禁止解析或构造，只能原样回传。
   * 用 cursor 而不是 offset：每条新消息都会 bump lastMessageAt（conversations 表的排序键），
   * offset 翻页必然重复/漏项——与 #6 冻结契约对商品 feed 的同一结论一致。
   */
  cursor: z.string().min(1).optional(),
})
export type ConversationListQuery = z.infer<typeof conversationListQuerySchema>

/**
 * 不另给 `hasMore` / `total`：与 #6 商品 feed 的冻结契约同一结论——
 * `nextCursor !== null` 已表达"还有下一页"，`total` 需要额外一次 COUNT 且无限滚动用不到。
 */
export const conversationListResponseSchema = z.object({
  /** 按 lastMessageAt 降序，DB 两个 (role, lastMessageAt) 索引支撑。 */
  items: z.array(conversationDtoSchema),
  nextCursor: z.string().nullable(),
})
export type ConversationListResponse = z.infer<typeof conversationListResponseSchema>

/**
 * 未读总数（#67）。**独立端点**，与通知域 `GET /notifications/unread-count` 同款：
 * 底部导航红点只要一个数字，不该为它拉一整页会话。
 *
 * 与列表行 `ConversationDto.unreadCount` 共用同一套 SQL 未读判据（store），
 * 因此它**恒等于**「把全部会话的 unreadCount 相加」，不受 `limit` / 游标分页影响。
 */
export const conversationUnreadCountSchema = z.object({
  unreadCount: z.number().int().nonnegative(),
})
export type ConversationUnreadCount = z.infer<typeof conversationUnreadCountSchema>

export const messageListQuerySchema = z.object({
  /** 游标分页：上一页最早一条消息的 id；缺省从最新一页开始。 */
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
})
export type MessageListQuery = z.infer<typeof messageListQuerySchema>

export const messageListResponseSchema = z.object({
  /** 按 (createdAt, id) 升序返回，与 DB 索引 messages_conversation_id_created_at_id_idx 一致。 */
  items: z.array(messageDtoSchema),
  /** null = 已到最早一页；否则作为下一次请求的 before 原样回传。 */
  nextCursor: z.string().nullable(),
})
export type MessageListResponse = z.infer<typeof messageListResponseSchema>

// ---------------------------------------------------------------------------
// WebSocket 实时协议（apps/api/src/modules/realtime）
// ---------------------------------------------------------------------------
//
// 冻结的三条连接语义（前端据此实现连接/重连）：
// ① 鉴权：upgrade 握手用 session cookie（浏览器同源 WS 自动携带），与 HTTP 同一身份。
// ② 失败：未认证时服务端在 upgrade 前拒绝（HTTP 401，连接不会建立），
//    客户端处理 onerror/onclose 即可，不存在「连上后再收错误帧」的状态。
// ③ 推送范围：服务端把「当前用户参与的全部会话」的新消息推给该连接，
//    没有 subscribe 帧——客户端不需要（也无法）选择订阅某个会话。

/** 服务端 → 客户端。消息先落库再推送；离线端重连后用历史端点补齐，推送不保证不重不漏。 */
export const realtimeServerEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message.new'),
    conversationId: z.string(),
    message: messageDtoSchema,
  }),
  /**
   * 会话读位被推进：`POST /conversations/:id/read` 落库成功后推送（与 message.new
   * 同一「先落库再推送」语义）。
   *
   * 推给会话双方而不是只推给对方：同一个人可能有多个连接 / 多台设备，其它连接也要
   * 同步读位。客户端按 `readerId` 与自己比对 —— 只有 `readerId !== me` 才把自己发的
   * 消息翻成「已读」，否则本人这次读操作会被误当成「对方已读」。
   */
  z.object({
    type: z.literal('conversation.read'),
    conversationId: z.string(),
    /** 读位被推进的那一方（即调用 read 端点的用户）。 */
    readerId: z.string(),
    /** 推进到的时刻（ISO，服务端权威）；`createdAt <= readAt` 的消息算已读。 */
    readAt: z.iso.datetime(),
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
  'MEDIA_OBJECT_NOT_FOUND',
  'MEDIA_OBJECT_INVALID',
  'MEDIA_DURATION_EXCEEDED',
  'MEDIA_DIMENSION_EXCEEDED',
  'MEDIA_NOT_FOUND',
  /**
   * 409：同一个 `clientRequestId` 被用来发送**内容不同**的消息（幂等键复用）。
   * 服务端拒绝而不是静默返回旧消息，否则调用方会以为新内容已送达。
   */
  'IDEMPOTENCY_KEY_REUSED',
])
export type ChatErrorCode = z.infer<typeof ChatErrorCodeSchema>
