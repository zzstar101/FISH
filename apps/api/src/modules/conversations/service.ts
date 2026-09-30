import {
  type ConversationDto,
  type ConversationListQuery,
  type ConversationListResponse,
  type ConversationUnreadCount,
  conversationDtoSchema,
  conversationListResponseSchema,
} from '@fish/contracts/chat/schema'
import { isForeignKeyViolation } from '@fish/db/pg-errors'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { PresenceReader } from '../presence/presence'
import { publicAvatarUrl } from '../uploads/avatar-url'
import { isListingReviewMediaKey } from '../uploads/review-media'
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

/**
 * 会话其中一侧的读位（ISO，从未读过为 null）。
 *
 * 会话严格双人（买家 + 卖家），所以「对方那一侧」只需按 `viewerId` 取反，不必再查参与表；
 * 两个读位列都由 store 的 JOIN 带回来了（`ConversationDetailRow.conversation`）。
 */
function readAtIso(
  row: ConversationDetailRow,
  viewerId: string,
  side: 'viewer' | 'counterpart',
): string | null {
  const viewerIsBuyer = row.conversation.buyer_id === viewerId
  const isBuyer = side === 'viewer' ? viewerIsBuyer : !viewerIsBuyer
  const raw = isBuyer ? row.conversation.buyer_last_read_at : row.conversation.seller_last_read_at
  return raw == null ? null : new Date(raw).toISOString()
}

/** joined 行 → 契约 DTO。coverUrl 在这里拼（存储布局不进读模型，与 #6 同一规则）。 */
function toConversationDto(
  row: ConversationDetailRow,
  viewerId: string,
  storage: MediaStorage,
  presence: PresenceReader,
): ConversationDto {
  return conversationDtoSchema.parse({
    id: encodePublicId(PUBLIC_ID_PREFIX.conversation, row.conversation.id),
    listingId: encodePublicId(PUBLIC_ID_PREFIX.listing, row.conversation.listing_id),
    role: row.conversation.buyer_id === viewerId ? 'buyer' : 'seller',
    listing: {
      id: encodePublicId(PUBLIC_ID_PREFIX.listing, row.listing.id),
      title: row.listing.title,
      priceCents: row.listing.priceCents,
      status: row.listing.status,
      // 审核中的图（私有 `listing-review-media/` 键）不在这里出图：#286 复审指出，任何登录用户只要对
      // 一条 REVIEW 商品建一次会话，就能从封面拿到 `GET /media/:token` 这种无会话的直读 URL。卖家在
      // 自己的商品详情里仍能看到审核中的图（那条路径按归属校验），会话封面统一不给。
      coverUrl:
        row.coverObjectKey && !isListingReviewMediaKey(row.coverObjectKey)
          ? storage.publicUrl(row.coverObjectKey)
          : null,
    },
    counterpart: {
      ...row.counterpart,
      id: encodePublicId(PUBLIC_ID_PREFIX.user, row.counterpart.id),
      avatarUrl: publicAvatarUrl(row.counterpart.avatarUrl),
    },
    /**
     * 对方的在线态（#359 第五点）。取的是**对方**（`row.counterpart.id`）的值 —— 会话页
     * 顶部栏显示的是对方在不在线；自己那一侧的在线态本页没有消费方（不顺手多查一个）。
     */
    counterpartPresence: presence.presenceOf(row.counterpart.id),
    unreadCount: row.unreadCount,
    counterpartLastReadAt: readAtIso(row, viewerId, 'counterpart'),
    lastMessage: row.lastMessage
      ? {
          // MEDIA 也是合法摘要类型（#67 第四步）：content 由 store 翻成 `[图片]`/`[语音]`。
          type: row.lastMessage.type as 'TEXT' | 'SYSTEM' | 'MEDIA',
          content: row.lastMessage.content,
          senderId: row.lastMessage.senderId
            ? encodePublicId(PUBLIC_ID_PREFIX.user, row.lastMessage.senderId)
            : null,
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
    input: { listingId: string },
  ): Promise<{ conversation: ConversationDto; created: boolean }>
  listConversations(userId: string, query: ConversationListQuery): Promise<ConversationListResponse>
  getConversation(userId: string, conversationId: string): Promise<ConversationDto>
  markRead(userId: string, conversationId: string): Promise<ConversationDto>
  /** 未读总数（#67）：服务端聚合全部会话，判据与列表行 `unreadCount` 同源（store）。 */
  getUnreadCount(userId: string): Promise<ConversationUnreadCount>
}

export function createConversationService({
  store,
  storage,
  presence,
  onRead,
  projectContent = async (_type: string, content: string) => content,
}: {
  store: ConversationStore
  storage: MediaStorage
  /**
   * 在线态读模型（#359 第五点）。**必填**：没有它 `ConversationDto.counterpartPresence`
   * 就无从组装（契约里是必填字段），给个「永远离线」的默认值只会把漏接线伪装成
   * 「对方恰好不在线」，在类型层就要求装配方显式提供。
   */
  presence: PresenceReader
  projectContent?: (type: string, content: string) => Promise<string>
  /**
   * 读位推进成功后调用（先落库再推送，与 messages 的 `onMessageCreated` 同语义）；
   * 推送失败不得影响 200 响应。
   */
  onRead?: (
    participants: { buyerId: string; sellerId: string },
    event: { conversationId: string; readerId: string; readAt: string },
  ) => void
}): ConversationService {
  async function projectedDto(
    row: ConversationDetailRow,
    viewerId: string,
  ): Promise<ConversationDto> {
    const lastMessage = row.lastMessage
    const projected = lastMessage
      ? {
          ...row,
          lastMessage: {
            ...lastMessage,
            content: await projectContent(lastMessage.type, lastMessage.content),
          },
        }
      : row
    return toConversationDto(projected, viewerId, storage, presence)
  }

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

      // 商品在「查存在 → 建会话」之间被卖家物理删除时，INSERT 会撞复合外键
      // `conversations_listing_id_seller_id_fk`（#74 的删除路径让这个窗口从"理论上"变成可达）。
      // 语义就是「商品不存在」，与上面那次查不到同码；不接住的话 23503 会走 app.onError 变成 500，
      // 而契约要求 404。判据与 `store.insertIfAbsent` 的返回分开：一个查不到、一个插不进。
      const inserted = await store
        .insertIfAbsent(input.listingId, userId, listing.sellerId)
        .catch((error: unknown) => {
          if (isForeignKeyViolation(error)) {
            throw new ConversationServiceError(404, 'LISTING_NOT_FOUND', '商品不存在')
          }
          throw error
        })
      const conversationId =
        inserted?.id ?? (await store.findIdByListingAndBuyer(input.listingId, userId))
      if (!conversationId) {
        // 防御分支：商品与卖家都是刚查到的，走到这里只能是会话行在竞态窗口里消失了
        // （并发下 `insertIfAbsent` 与 `findIdByListingAndBuyer` 之间另一事务删掉了它）。
        // 语义是"会话不在"，不是"商品不在"。
        throw notFound()
      }

      const detail = await store.findDetail(conversationId, userId)
      if (!detail) throw notFound()

      // 单会话路径与列表路径共用同一封面来源（store 只给 objectKey，URL 在 toConversationDto 拼）。
      const covers = await store.coverObjectKeys([detail.listing.id])
      detail.coverObjectKey = covers.get(detail.listing.id) ?? detail.coverObjectKey

      return {
        conversation: await projectedDto(detail, userId),
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
        items: await Promise.all(items.map((row) => projectedDto(row, userId))),
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
      return projectedDto(detail, userId)
    },

    async markRead(userId, conversationId) {
      const detail = await store.markRead(conversationId, userId)
      if (!detail) throw notFound()
      // store.markRead 的 UPDATE 用 SQL now() 推进查看者那一侧，返回的 detail 行里
      // 已带回推进后的读位——本次 readAt 就是「查看者侧」那个值，不需要再取一次时间
      // （自己取 now() 会与库里落的值有偏差，客户端按它比对已读会漏掉最近一条）。
      const readAt = readAtIso(detail, userId, 'viewer')
      if (readAt) {
        onRead?.(
          { buyerId: detail.conversation.buyer_id, sellerId: detail.conversation.seller_id },
          { conversationId, readerId: userId, readAt },
        )
      }
      return projectedDto(detail, userId)
    },

    async getUnreadCount(userId) {
      return { unreadCount: await store.countUnread(userId) }
    },
  }
}
