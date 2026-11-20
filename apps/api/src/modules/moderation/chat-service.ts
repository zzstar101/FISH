import type { MediaMessageDto, MessageDto } from '@fish/contracts/chat/schema'
import {
  type ChatModerationDecisionInput,
  ChatModerationDecisionResponseSchema,
  type ChatModerationErrorCode,
  type ChatModerationQueueQuery,
  ChatModerationQueueResponseSchema,
} from '@fish/contracts/moderation/chat-schema'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { decodeCursor, encodeCursor } from '../admin/cursor'
import { toMediaDto } from '../messages/media-service'
import { toMessageDto } from '../messages/service'
import type { ChatModerationQueueRow, ChatModerationStore } from './chat-store'

export class ChatModerationServiceError extends Error {
  constructor(
    readonly code: ChatModerationErrorCode,
    readonly status: 404 | 409 | 422,
    message: string,
  ) {
    super(message)
    this.name = 'ChatModerationServiceError'
  }
}

export type ChatModerationDelivery =
  | { kind: 'message'; buyerId: string; sellerId: string; message: MessageDto }
  | { kind: 'media'; buyerId: string; sellerId: string; media: MediaMessageDto }

export type ChatModerationService = {
  list(
    query: ChatModerationQueueQuery,
  ): Promise<ReturnType<typeof ChatModerationQueueResponseSchema.parse>>
  decide(
    recordId: string,
    input: ChatModerationDecisionInput,
    actorUserId: string,
  ): Promise<ReturnType<typeof ChatModerationDecisionResponseSchema.parse>>
  findMedia(
    recordId: string,
  ): Promise<{ objectKey: string; contentType: string; sizeBytes: number | null } | null>
}

function invalidCursor(): ChatModerationServiceError {
  return new ChatModerationServiceError('INVALID_CURSOR', 422, '分页游标无效')
}

function toQueueItem(row: ChatModerationQueueRow) {
  return {
    id: encodePublicId(PUBLIC_ID_PREFIX.chatModerationRecord, row.id),
    messageId: encodePublicId(PUBLIC_ID_PREFIX.message, row.messageId),
    conversationId: encodePublicId(PUBLIC_ID_PREFIX.conversation, row.conversationId),
    sender: {
      id: encodePublicId(PUBLIC_ID_PREFIX.user, row.senderId),
      nickname: row.senderNickname,
    },
    kind: row.kind,
    decision: row.decision,
    suggestion: row.suggestion,
    provider: row.provider,
    policyVersion: row.policyVersion,
    score: row.score,
    matchedRules: row.matchedRules,
    matchedTermsMasked: row.matchedTermsMasked,
    content: row.kind === 'TEXT' ? row.content : null,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    hasMedia: row.mimeType !== null,
    version: row.version,
    createdAt: new Date(row.createdAt).toISOString(),
  }
}

/**
 * 管理端聊天待审（#694 M2）。
 *
 * 决策与投递在同一事务（store.decide 里改 visibility + delivered_at + 审计），本 service 只在
 * `applied && ALLOW` 时把已经提交的消息 DTO 推给双方一次：幂等重放不会重复投递或重复未读。
 */
export function createChatModerationService(options: {
  store: ChatModerationStore
  /** 媒体消息投递时的 URL 拼装（与 media-service 共用同一路径规则）。 */
  mediaUrl: (conversationId: string, mediaId: string) => string
  onDelivered?: (delivery: ChatModerationDelivery) => void
}): ChatModerationService {
  const { store } = options
  return {
    async list(query) {
      const cursor = query.cursor
        ? decodeCursor(query.cursor, PUBLIC_ID_PREFIX.chatModerationRecord)
        : null
      if (query.cursor && !cursor) throw invalidCursor()

      const rows = await store.listPending({ cursor, limit: query.limit + 1 })
      const hasMore = rows.length > query.limit
      const items = rows.slice(0, query.limit)
      const last = items[items.length - 1]
      const payload = {
        items: items.map(toQueueItem),
        nextCursor:
          hasMore && last
            ? encodeCursor(last.createdAtCursor, last.id, PUBLIC_ID_PREFIX.chatModerationRecord)
            : null,
      }
      return ChatModerationQueueResponseSchema.parse(payload)
    },

    async decide(recordId, input, actorUserId) {
      const result = await store.decide({
        recordId,
        decision: input.decision,
        reason: input.reason,
        version: input.version,
        actorUserId,
      })
      if (result.outcome === 'not-found') {
        throw new ChatModerationServiceError('CHAT_MODERATION_NOT_FOUND', 404, '待审记录不存在')
      }
      if (result.outcome === 'conflict') {
        throw new ChatModerationServiceError(
          'CHAT_MODERATION_CONFLICT',
          409,
          '该待审记录已被处理或版本已过期，请刷新后重试',
        )
      }
      if (result.outcome === 'applied' && result.visibility === 'DELIVERED') {
        const message = result.message
        if (message.type === 'MEDIA' && message.media) {
          const media = message.media
          const mediaDto = toMediaDto(
            {
              media_id: media.id,
              message_id: message.id,
              conversation_id: message.conversation_id,
              sender_id: message.sender_id,
              kind: media.kind,
              object_key: '',
              mime_type: media.mimeType,
              size_bytes: media.sizeBytes,
              width: media.width,
              height: media.height,
              duration_ms: media.durationMs,
              reply_to_id: message.reply_to_id,
              recalled_at: message.recalled_at,
              created_at: message.created_at,
              created_at_iso: new Date(message.created_at).toISOString(),
              visibility: 'DELIVERED',
            },
            (mediaId) =>
              options.mediaUrl(
                encodePublicId(PUBLIC_ID_PREFIX.conversation, message.conversation_id),
                mediaId,
              ),
          )
          options.onDelivered?.({
            kind: 'media',
            buyerId: result.buyerId,
            sellerId: result.sellerId,
            media: mediaDto,
          })
        } else {
          options.onDelivered?.({
            kind: 'message',
            buyerId: result.buyerId,
            sellerId: result.sellerId,
            message: toMessageDto(message as Parameters<typeof toMessageDto>[0]),
          })
        }
      }
      return ChatModerationDecisionResponseSchema.parse({
        id: encodePublicId(PUBLIC_ID_PREFIX.chatModerationRecord, result.recordId),
        messageId: encodePublicId(PUBLIC_ID_PREFIX.message, result.messageId),
        decision: input.decision,
        replayed: result.outcome === 'replayed',
      })
    },

    async findMedia(recordId) {
      return store.findMediaSnapshot(recordId)
    },
  }
}
