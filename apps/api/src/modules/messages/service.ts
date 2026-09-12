import {
  type MessageDto,
  type MessageListQuery,
  type MessageListResponse,
  type MessageSendInput,
  messageDtoSchema,
  messageListResponseSchema,
} from '@fish/contracts/chat/schema'
import type { MessageRow, MessageStore } from './store'

export class MessageServiceError extends Error {
  constructor(
    readonly status: 404 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'MessageServiceError'
  }
}

const notFound = () => new MessageServiceError(404, 'CONVERSATION_NOT_FOUND', '会话不存在')

function toMessageDto(row: MessageRow): MessageDto {
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

export function createMessageService({ store }: { store: MessageStore }): MessageService {
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
      const row = await store.insertText(conversationId, userId, input.content.trim())
      return toMessageDto(row)
    },
  }
}
