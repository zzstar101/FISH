import {
  type ConversationCreateInput,
  type ConversationDto,
  type ConversationListQuery,
  type ConversationListResponse,
  conversationDtoSchema,
  conversationListResponseSchema,
} from '@fish/contracts/chat/schema'
import type { MediaStorage } from '../uploads/storage'
import { decodeCursor, encodeCursor } from './cursor'
import type { ConversationDetailRow, ConversationStore } from './store'

export class ConversationServiceError extends Error {
  constructor(
    /** HTTP 状态码；code 取值域由契约的 ChatErrorCodeSchema 收窄。 */
    readonly status: 403 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ConversationServiceError'
  }
}

const notFound = () => new ConversationServiceError(404, 'CONVERSATION_NOT_FOUND', '会话不存在')

/** joined 行 → 契约 DTO。coverUrl 在这里拼（存储布局不进读模型，与 #6 同一规则）。 */
function toConversationDto(
  row: ConversationDetailRow,
  viewerId: string,
  storage: MediaStorage,
): ConversationDto {
  return conversationDtoSchema.parse({
    id: row.conversation.id,
    listingId: row.conversation.listing_id,
    role: row.conversation.buyer_id === viewerId ? 'buyer' : 'seller',
    listing: {
      id: row.listing.id,
      title: row.listing.title,
      priceCents: row.listing.priceCents,
      status: row.listing.status,
      coverUrl: row.coverObjectKey ? storage.publicUrl(row.coverObjectKey) : null,
    },
    counterpart: row.counterpart,
    unreadCount: row.unreadCount,
    lastMessage: row.lastMessage
      ? {
          type: row.lastMessage.type as 'TEXT' | 'SYSTEM',
          content: row.lastMessage.content,
          senderId: row.lastMessage.senderId,
          createdAt: new Date(row.lastMessage.createdAt).toISOString(),
        }
      : null,
    lastMessageAt: new Date(row.conversation.last_message_at).toISOString(),
    createdAt: new Date(row.conversation.created_at).toISOString(),
  })
}

export interface ConversationService {
  /** 创建/复用会话。复用返回 created=false（路由据此输出 200/201）。 */
  createOrGetConversation(
    userId: string,
    input: ConversationCreateInput,
  ): Promise<{ conversation: ConversationDto; created: boolean }>
  listConversations(userId: string, query: ConversationListQuery): Promise<ConversationListResponse>
  getConversation(userId: string, conversationId: string): Promise<ConversationDto>
  markRead(userId: string, conversationId: string): Promise<ConversationDto>
}

export function createConversationService({
  store,
  storage,
}: {
  store: ConversationStore
  storage: MediaStorage
}): ConversationService {
  return {
    async createOrGetConversation(userId, input) {
      const listing = await store.findListingBrief(input.listingId)
      if (!listing) {
        throw new ConversationServiceError(404, 'LISTING_NOT_FOUND', '商品不存在')
      }
      // DB CHECK conversations_buyer_id_differs_from_seller_id 的同源前置校验：
      // 在 INSERT 之前拦下，错误码比 500 的 CHECK 违规可读。
      if (listing.sellerId === userId) {
        throw new ConversationServiceError(409, 'CANNOT_CHAT_WITH_SELF', '不能和自己的商品建立会话')
      }

      const inserted = await store.insertIfAbsent(input.listingId, userId, listing.sellerId)
      const conversationId =
        inserted?.id ?? (await store.findIdByListingAndBuyer(input.listingId, userId))
      if (!conversationId) {
        // 防御分支：商品刚查过必然存在，走到这里只能是会话行在竞态窗口里消失了
        // （P0 无删除路径，实际不可达）。语义是"会话不在"，不是"商品不在"。
        throw notFound()
      }

      const detail = await store.findDetail(conversationId, userId)
      if (!detail) throw notFound()

      // 单会话路径与列表路径共用同一封面来源（store 只给 objectKey，URL 在 toConversationDto 拼）。
      const covers = await store.coverObjectKeys([detail.listing.id])
      detail.coverObjectKey = covers.get(detail.listing.id) ?? detail.coverObjectKey

      return {
        conversation: toConversationDto(detail, userId, storage),
        created: inserted !== null,
      }
    },

    async listConversations(userId, query) {
      const cursor = query.cursor ? decodeCursor(query.cursor) : null
      if (query.cursor && !cursor) {
        throw new ConversationServiceError(422, 'VALIDATION_FAILED', '游标不合法')
      }

      // 多取一行判断"还有没有下一页"，返回前丢掉（契约：不另给 hasMore）。
      const rows = await store.listForUser(userId, { limit: query.limit, cursor })
      const hasMore = rows.length > query.limit
      const page = hasMore ? rows.slice(0, query.limit) : rows

      const covers = await store.coverObjectKeys(page.map((row) => row.listing.id))
      const items = page.map((row) => ({
        ...row,
        coverObjectKey: covers.get(row.listing.id) ?? row.coverObjectKey,
      }))

      const last = page.at(-1)
      return conversationListResponseSchema.parse({
        items: items.map((row) => toConversationDto(row, userId, storage)),
        nextCursor:
          hasMore && last?.lastMessageAtCursor
            ? encodeCursor({ sortKey: last.lastMessageAtCursor, id: last.conversation.id })
            : null,
      })
    },

    async getConversation(userId, conversationId) {
      const detail = await store.findDetail(conversationId, userId)
      if (!detail) throw notFound()
      const covers = await store.coverObjectKeys([detail.listing.id])
      detail.coverObjectKey = covers.get(detail.listing.id) ?? detail.coverObjectKey
      return toConversationDto(detail, userId, storage)
    },

    async markRead(userId, conversationId) {
      const detail = await store.markRead(conversationId, userId)
      if (!detail) throw notFound()
      return toConversationDto(detail, userId, storage)
    },
  }
}
