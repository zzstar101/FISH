import { MeSchema } from '@fish/contracts/auth/user'
import {
  type ChatWatchersQuery,
  type ChatWatchersResponse,
  chatWatchersResponseSchema,
} from '@fish/contracts/chat/schema'
import { decodeCursor, encodeCursor } from './cursor'
import { ConversationServiceError } from './service'
import type { ConversationStore } from './store'

export type ChatWatchersService = {
  list(userId: string, listingId: string, query: ChatWatchersQuery): Promise<ChatWatchersResponse>
}

/** 「想要的人」只认已建立会话，且只有商品卖家可读；不读取消息正文。 */
export function createChatWatchersService(
  store: Pick<ConversationStore, 'findListingBrief' | 'listChatWatchers'>,
): ChatWatchersService {
  return {
    async list(userId, listingId, query) {
      const listing = await store.findListingBrief(listingId)
      if (!listing) throw new ConversationServiceError(404, 'LISTING_NOT_FOUND', '商品不存在')
      if (listing.sellerId !== userId) {
        throw new ConversationServiceError(403, 'NOT_LISTING_OWNER', '只能查看自己商品的想要的人')
      }
      const cursor = query.cursor ? decodeCursor(query.cursor) : null
      if (query.cursor && !cursor) {
        throw new ConversationServiceError(422, 'VALIDATION_FAILED', '游标不合法')
      }
      const result = await store.listChatWatchers(listingId, userId, { limit: query.limit, cursor })
      const page = result.rows.slice(0, query.limit)
      const last = page.at(-1)
      return chatWatchersResponseSchema.parse({
        items: page.map((row) => ({
          user: {
            id: row.userId,
            nickname: row.nickname,
            avatarUrl: MeSchema.shape.avatarUrl.safeParse(row.avatarUrl).data ?? null,
            authStatus: row.authStatus,
          },
          startedAt: new Date(row.startedAt).toISOString(),
        })),
        nextCursor:
          result.rows.length > query.limit && last
            ? encodeCursor({ sortKey: last.startedAtCursor, id: last.conversationId })
            : null,
        total: result.total,
      })
    },
  }
}
