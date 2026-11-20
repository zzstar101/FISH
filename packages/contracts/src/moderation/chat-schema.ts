import { z } from 'zod'
import {
  ChatModerationRecordIdSchema,
  ConversationIdSchema,
  MessageIdSchema,
  UserIdSchema,
} from '../system/public-id'

/**
 * 聊天待审队列契约（#694 M2 管理端）。
 *
 * 只暴露最小上下文：单条消息正文（TEXT）或媒体元数据 + 是否可读快照，不上传客户端证据。
 * 媒体字节必须走带管理员鉴权的媒体端点，不能在 DTO 里塞公网 URL。
 */

export const ChatModerationKindSchema = z.enum(['TEXT', 'IMAGE', 'VOICE'])
export type ChatModerationKind = z.infer<typeof ChatModerationKindSchema>

export const ChatModerationProviderSchema = z.enum(['LOCAL', 'TENCENT_TMS', 'TENCENT_IMS'])
export type ChatModerationProvider = z.infer<typeof ChatModerationProviderSchema>

export const ChatModerationSuggestionSchema = z.enum(['Pass', 'Review', 'Block'])
export type ChatModerationSuggestion = z.infer<typeof ChatModerationSuggestionSchema>

export const ChatModerationDecisionSchema = z.enum(['ALLOW', 'BLOCK'])
export type ChatModerationDecision = z.infer<typeof ChatModerationDecisionSchema>

export const ChatModerationQueueItemSchema = z.object({
  /** 审核记录公开 ID（cmr_）。 */
  id: ChatModerationRecordIdSchema,
  messageId: MessageIdSchema,
  conversationId: ConversationIdSchema,
  sender: z.object({ id: UserIdSchema, nickname: z.string() }),
  kind: ChatModerationKindSchema,
  /** 机器结论（REVIEW 才会进队列，这里保留原始判定便于排查）。 */
  decision: z.enum(['ALLOW', 'BLOCK', 'REVIEW']),
  /** DB 列可空（历史/上游缺失时归一为空），管理页按「未知」展示，不能让整页 422。 */
  suggestion: ChatModerationSuggestionSchema.nullable(),
  provider: ChatModerationProviderSchema,
  policyVersion: z.string(),
  score: z.number().min(0).max(100).nullable(),
  matchedRules: z.array(z.string()),
  matchedTermsMasked: z.array(z.string()),
  /** TEXT 正文；媒体为 null（正文不是审核字段）。 */
  content: z.string().nullable(),
  mimeType: z.string().nullable(),
  sizeBytes: z.number().int().nullable(),
  hasMedia: z.boolean(),
  /** 乐观并发版本：处理时必须回传，冲突返回 409。 */
  version: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
})
export type ChatModerationQueueItem = z.infer<typeof ChatModerationQueueItemSchema>

export const ChatModerationQueueQuerySchema = z.strictObject({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})
export type ChatModerationQueueQuery = z.infer<typeof ChatModerationQueueQuerySchema>

export const ChatModerationQueueResponseSchema = z.object({
  items: z.array(ChatModerationQueueItemSchema),
  nextCursor: z.string().nullable(),
})
export type ChatModerationQueueResponse = z.infer<typeof ChatModerationQueueResponseSchema>

export const ChatModerationDecisionInputSchema = z.strictObject({
  decision: ChatModerationDecisionSchema,
  reason: z.string().trim().min(1).max(500),
  version: z.number().int().nonnegative(),
})
export type ChatModerationDecisionInput = z.infer<typeof ChatModerationDecisionInputSchema>

export const ChatModerationDecisionResponseSchema = z.object({
  id: ChatModerationRecordIdSchema,
  messageId: MessageIdSchema,
  decision: ChatModerationDecisionSchema,
  /** 幂等重放：同一结论重复提交时为 true。 */
  replayed: z.boolean(),
})
export type ChatModerationDecisionResponse = z.infer<typeof ChatModerationDecisionResponseSchema>

export const CHAT_MODERATION_ROUTES = {
  queue: '/admin/chat-moderation',
  decision: (recordId: string) => `/admin/chat-moderation/${recordId}/decision`,
  media: (recordId: string) => `/admin/chat-moderation/${recordId}/media`,
} as const

export const ChatModerationErrorCodeSchema = z.enum([
  'CHAT_MODERATION_NOT_FOUND',
  'CHAT_MODERATION_CONFLICT',
  'INVALID_CURSOR',
])
export type ChatModerationErrorCode = z.infer<typeof ChatModerationErrorCodeSchema>
