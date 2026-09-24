import {
  type MessageDto,
  type MessageListQuery,
  type MessageListResponse,
  type MessageSendInput,
  messageDtoSchema,
  messageListResponseSchema,
} from '@fish/contracts/chat/schema'
import { MessageIdempotencyConflictError, messageSendKey, textRequestHash } from './idempotency'
import type { MessageRow, MessageStore } from './store'

export class MessageServiceError extends Error {
  constructor(
    readonly status: 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'MessageServiceError'
  }
}

const notFound = () => new MessageServiceError(404, 'CONVERSATION_NOT_FOUND', '会话不存在')

/** 同键不同内容：拒绝而不是静默返回旧消息，否则调用方会以为新内容已送达（丢消息）。 */
const idempotencyConflict = () =>
  new MessageServiceError(409, 'IDEMPOTENCY_KEY_REUSED', '同一个 clientRequestId 携带了不同内容')

export function toMessageDto(row: MessageRow): MessageDto {
  return messageDtoSchema.parse({
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    sender:
      row.sender_id && row.sender_nickname
        ? {
            id: row.sender_id,
            nickname: row.sender_nickname,
            avatarUrl: row.sender_avatar_url ?? null,
          }
        : null,
    type: row.type,
    content: row.content,
    createdAt: new Date(row.created_at).toISOString(),
  })
}

export interface MessageService {
  listMessages(
    userId: string,
    conversationId: string,
    query: MessageListQuery,
  ): Promise<MessageListResponse>
  sendTextMessage(
    userId: string,
    conversationId: string,
    input: MessageSendInput,
  ): Promise<MessageDto>
}

export function createMessageService({
  store,
  /** 先落库再推送（#9 契约冻结语义）：消息持久化成功后调用；推送失败不得影响响应。 */
  onMessageCreated,
}: {
  store: MessageStore
  onMessageCreated?: (
    participants: { buyerId: string; sellerId: string },
    message: MessageDto,
  ) => void
}): MessageService {
  return {
    async listMessages(userId, conversationId, query) {
      const conversation = await store.findConversationForUser(conversationId, userId)
      // 非参与者与不存在统一 404：不泄漏"会话存在但不是你的"。
      if (!conversation) throw notFound()

      const result = await store.listByConversation(conversationId, {
        limit: query.limit,
        before: query.before ?? null,
      })
      if (result.kind === 'invalid-cursor') {
        throw new MessageServiceError(422, 'VALIDATION_FAILED', '游标不合法')
      }

      const hasMore = result.rows.length > query.limit
      // rows 已反转为升序；超出 limit 的部分是**最早**的多余行，从头部丢掉，
      // 保留最新的 limit 条。最早的一条（page[0]）即下一页游标。
      const page = hasMore ? result.rows.slice(-query.limit) : result.rows
      const oldest = page[0]
      return messageListResponseSchema.parse({
        items: page.map(toMessageDto),
        // 升序页的最早一条即下一页游标；没有更早的消息时为 null（契约：无 hasMore 字段）。
        nextCursor: hasMore && oldest ? oldest.id : null,
      })
    },

    async sendTextMessage(userId, conversationId, input) {
      // router 已用契约 schema safeParse 过（422 走校验信封）；这里只保留 trim 不变量，
      // 不重复 parse——内部误用时 ZodError 落 app.onError 而不是 422，反而更难查。
      const conversation = await store.findConversationForUser(conversationId, userId)
      if (!conversation) throw notFound()
      const content = input.content.trim()
      // #67 幂等键：指纹取 trim 后的正文（与落库的 content 同一值）；未携带键时为 null。
      const key = messageSendKey(input.clientRequestId, textRequestHash(content))
      let row: MessageRow
      try {
        row = await store.insertText(conversationId, userId, content, key)
      } catch (error) {
        if (error instanceof MessageIdempotencyConflictError) throw idempotencyConflict()
        throw error
      }
      const dto = toMessageDto(row)
      // 先落库（上面已 await）再推送；推送失败由 hub 吞掉，不影响 201 响应。
      // 重试命中既有消息时也会推一次：契约明确「推送不保证不重不漏」，客户端按服务端
      // id 去重（#67 第三步），这里不为去重再引入「新建/重放」的返回值分叉。
      onMessageCreated?.({ buyerId: conversation.buyerId, sellerId: conversation.sellerId }, dto)
      return dto
    },
  }
}
