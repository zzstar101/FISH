import {
  type ConversationListing,
  conversationListingSchema,
  type ListingMessageSendInput,
  type MessageDto,
  type MessageListQuery,
  type MessageListResponse,
  type MessageSendInput,
  messageDtoSchema,
  messageListResponseSchema,
} from '@fish/contracts/chat/schema'
import { isForeignKeyViolation } from '@fish/db/pg-errors'
import {
  decodePublicId,
  encodePublicId,
  isPublicId,
  PUBLIC_ID_PREFIX,
} from '@fish/shared/public-id'
import { publicAvatarUrl } from '../uploads/avatar-url'
import { isListingReviewMediaKey } from '../uploads/review-media'
import type { MediaStorage } from '../uploads/storage'
import {
  listingRequestHash,
  MessageIdempotencyConflictError,
  messageSendKey,
  textRequestHash,
} from './idempotency'
import type { ListingBrief, MessageRow, MessageStore } from './store'

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

/** 商品不存在 / 不可见统一 404：不区分两种原因（与 listings/users 的「不给状态空间开探针」同取舍）。 */
const listingNotFound = () =>
  new MessageServiceError(404, 'LISTING_NOT_FOUND', '商品不存在或不可见')

/** 同键不同内容：拒绝而不是静默返回旧消息，否则调用方会以为新内容已送达（丢消息）。 */
const idempotencyConflict = () =>
  new MessageServiceError(409, 'IDEMPOTENCY_KEY_REUSED', '同一个 clientRequestId 携带了不同内容')

/**
 * 行 → 契约 DTO。
 *
 * `listing` 只有 LISTING 消息（#359）才有值，且必须由**调用方**注入 —— 商品投射要额外查一次
 * listings（见 `resolveListingProjections`），而这个函数同时被交易模块的 SYSTEM 消息复用，
 * 不该在那里引入商品依赖。缺省 null：TEXT / SYSTEM 的契约值就是 null。
 */
export function toMessageDto(
  row: MessageRow,
  listing: ConversationListing | null = null,
): MessageDto {
  return messageDtoSchema.parse({
    id: encodePublicId(PUBLIC_ID_PREFIX.message, row.id),
    conversationId: encodePublicId(PUBLIC_ID_PREFIX.conversation, row.conversation_id),
    senderId: row.sender_id ? encodePublicId(PUBLIC_ID_PREFIX.user, row.sender_id) : null,
    sender:
      row.sender_id && row.sender_nickname
        ? {
            id: encodePublicId(PUBLIC_ID_PREFIX.user, row.sender_id),
            nickname: row.sender_nickname,
            avatarUrl: publicAvatarUrl(row.sender_avatar_url ?? null),
          }
        : null,
    type: row.type,
    content: row.content,
    listing,
    createdAt: new Date(row.created_at).toISOString(),
  })
}

/**
 * 商品行 → 会话卡片投射（#359）。
 *
 * 字段与会话头商品卡（conversations/service.ts 的 `listing`）逐字同口径：封面的 objectKey →
 * URL 由注入的 MediaStorage 拼，且**审核中的图不出 URL**（私有 `listing-review-media/` 前缀，
 * #286 复审 blocker 1：否则任何收到这张卡的人都能直读审核中商品的图）。
 * 走 `conversationListingSchema.parse` 而不是手搓对象：status 这类枚举在契约边界收口，
 * 脏数据在这里炸掉而不是流到前端。
 */
function toListingCard(brief: ListingBrief, storage: MediaStorage): ConversationListing {
  return conversationListingSchema.parse({
    id: encodePublicId(PUBLIC_ID_PREFIX.listing, brief.id),
    title: brief.title,
    priceCents: brief.priceCents,
    status: brief.status,
    coverUrl:
      brief.coverObjectKey && !isListingReviewMediaKey(brief.coverObjectKey)
        ? storage.publicUrl(brief.coverObjectKey)
        : null,
  })
}

/** LISTING 的 `content` 是商品公开 id；不是合法公开 id（脏数据）时按「商品不可得」处理。 */
function listingUuidOf(content: string): string | null {
  if (!isPublicId(PUBLIC_ID_PREFIX.listing, content)) return null
  return decodePublicId(PUBLIC_ID_PREFIX.listing, content)
}

/** 单条 LISTING 的投射（发送 / 重放路径用；不可得时为 null）。 */
async function listingCardOf(
  store: MessageStore,
  storage: MediaStorage,
  listingPublicId: string,
): Promise<ConversationListing | null> {
  const uuid = listingUuidOf(listingPublicId)
  if (!uuid) return null
  const brief = (await store.findListingBriefs([uuid])).get(uuid)
  return brief ? toListingCard(brief, storage) : null
}

/**
 * 一页消息的 LISTING 富化（#359）。
 *
 * content 存的是商品**公开 id**，要先解回内部 uuid 才能 join；因此整页只做**一次**
 * `findListingBriefs`，不按条 N+1。商品被物理删除（#74 的删除路径）时该条为 null，
 * 客户端按失效卡渲染——不为一条历史消息把整页 500 掉。
 */
async function resolveListingProjections(
  store: MessageStore,
  storage: MediaStorage,
  rows: readonly MessageRow[],
): Promise<Map<string, ConversationListing>> {
  const uuidByMessageId = new Map<string, string>()
  for (const row of rows) {
    if (row.type !== 'LISTING') continue
    const uuid = listingUuidOf(row.content)
    if (uuid) uuidByMessageId.set(row.id, uuid)
  }
  const projections = new Map<string, ConversationListing>()
  if (uuidByMessageId.size === 0) return projections
  const briefs = await store.findListingBriefs([...new Set(uuidByMessageId.values())])
  for (const [messageId, uuid] of uuidByMessageId) {
    const brief = briefs.get(uuid)
    if (brief) projections.set(messageId, toListingCard(brief, storage))
  }
  return projections
}

type InternalMessageListQuery = Omit<MessageListQuery, 'before'> & { before?: string }

export interface MessageService {
  listMessages(
    userId: string,
    conversationId: string,
    query: InternalMessageListQuery,
  ): Promise<MessageListResponse>
  sendTextMessage(
    userId: string,
    conversationId: string,
    input: MessageSendInput,
  ): Promise<MessageDto>
  /**
   * 发一条 LISTING（商品卡）消息（#359）。发送者须是会话双方之一；商品须存在且公开可见；
   * 幂等语义与 TEXT 同源（同键同商品 → 重放，同键不同商品 → 409）。
   */
  sendListingMessage(
    userId: string,
    conversationId: string,
    input: ListingMessageSendInput,
  ): Promise<MessageDto>
}

export function createMessageService({
  store,
  /** LISTING 卡片封面 URL 的拼装（存储布局不进读模型，与 conversations 同一注入方式）。 */
  storage,
  /** 先落库再推送（#9 契约冻结语义）：消息持久化成功后调用；推送失败不得影响响应。 */
  onMessageCreated,
  projectContent = async (_type: string, content: string) => content,
}: {
  store: MessageStore
  storage: MediaStorage
  projectContent?: (type: string, content: string) => Promise<string>
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
      // 先批量解出本页 LISTING 的商品投射，再逐条组装 DTO（顺序与页一致）。
      const listings = await resolveListingProjections(store, storage, page)
      return messageListResponseSchema.parse({
        items: await Promise.all(
          page.map(async (row) =>
            toMessageDto(
              { ...row, content: await projectContent(row.type, row.content) },
              listings.get(row.id) ?? null,
            ),
          ),
        ),
        // 升序页的最早一条即下一页游标；没有更早的消息时为 null（契约：无 hasMore 字段）。
        nextCursor: hasMore && oldest ? encodePublicId(PUBLIC_ID_PREFIX.message, oldest.id) : null,
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
        /*
         * 会话在「读会话 → 写消息」之间被删掉：`messages.conversation_id` 的外键拒绝这次写入。
         *
         * 会话随商品物理删除（#74 的删除路径连带清 `conversations` 与其消息），所以这个窗口
         * 从「理论上」变成可达。语义就是「会话不存在」，与上面那次查不到同码 —— 不接住的话
         * 23503 会走 `app.onError` 变成 500，而契约要求 404。
         */
        if (isForeignKeyViolation(error)) throw notFound()
        throw error
      }
      const dto = toMessageDto(row)
      // 先落库（上面已 await）再推送；推送失败由 hub 吞掉，不影响 201 响应。
      // 重试命中既有消息时也会推一次：契约明确「推送不保证不重不漏」，客户端按服务端
      // id 去重（#67 第三步），这里不为去重再引入「新建/重放」的返回值分叉。
      onMessageCreated?.({ buyerId: conversation.buyerId, sellerId: conversation.sellerId }, dto)
      return dto
    },

    async sendListingMessage(userId, conversationId, input) {
      const conversation = await store.findConversationForUser(conversationId, userId)
      // 非参与者与「会话不存在」同码（域内既有口径，见 listMessages 的同名注释）：
      // LISTING_NOT_FOUND 只表达「商品不可见」，不用于会话侧的身份判定。
      if (!conversation) throw notFound()

      // content 就是公开 id（引用而非用户正文）；指纹取同一个值，重试用同一个键即可重放。
      const key = messageSendKey(input.clientRequestId, listingRequestHash(input.listingId))

      /*
       * 幂等先于可见性：命中既有键就要先给出「重放 / 409」的结论，否则
       * - 同一个键换了商品时会被商品可见性的 404 抢先，契约要求的是 409；
       * - 商品在「首发成功 → 客户端重试」之间下架 / 被删时，重试会错误地报 404，
       *   而这条消息其实已经落库（客户端会以为自己发失败了）。
       * 这里只决定错误顺序；真正的去重仍由 store 在事务内的 advisory lock + 查重兜住。
       */
      const replay = key ? await store.findMessageByRequestKey(conversationId, userId, key) : null
      if (replay) {
        if (!replay.hashMatches) throw idempotencyConflict()
        // 重放：投射取商品**此刻**的状态（可能已下架 / 已被物理删除 → 失效卡）。
        const dto = toMessageDto(replay.row, await listingCardOf(store, storage, input.listingId))
        // 与 sendTextMessage 的重放语义一致：命中既有消息**也推一次**（契约「推送不保证不重
        // 不漏」，客户端按服务端 id 去重）。否则首次推送丢失时，重试成功却通知不到对方。
        onMessageCreated?.({ buyerId: conversation.buyerId, sellerId: conversation.sellerId }, dto)
        return dto
      }

      /*
       * 「存在且可见」的口径 = 公开在售的可见性判据 `status = 'ACTIVE' AND
       * moderation_status = 'APPROVED'`（与 listings feed 的 `includeUnapproved: false`
       * 和 users 的公开在售列表/在售计数同源，见 users/store.ts 的 stats 注释）。
       *
       * 不只看 status：`listings.moderation_status` 有独立写入方（治理下架、人工终审、
       * 未来加的审核通道），只判 status 会把「公开列表里看不见的商品」分享进会话。
       * 不存在 / 非在售 / 未过审统一 404 `LISTING_NOT_FOUND`，不给状态空间开探针。
       */
      const listingUuid = listingUuidOf(input.listingId)
      const brief = listingUuid
        ? (await store.findListingBriefs([listingUuid])).get(listingUuid)
        : undefined
      const shareable = brief?.status === 'ACTIVE' && brief.moderationStatus === 'APPROVED'
      if (!shareable) throw listingNotFound()

      let row: MessageRow
      try {
        row = await store.insertListing(conversationId, userId, input.listingId, key)
      } catch (error) {
        if (error instanceof MessageIdempotencyConflictError) throw idempotencyConflict()
        // 与 sendTextMessage 同一窗口：会话在「读会话 → 写消息」之间被物理删除 → 404。
        if (isForeignKeyViolation(error)) throw notFound()
        throw error
      }
      const dto = toMessageDto(row, toListingCard(brief, storage))
      // 先落库再推送：在线的对方由 message.new 拿到同一份富化 DTO（同源，前端零 N+1）。
      onMessageCreated?.({ buyerId: conversation.buyerId, sellerId: conversation.sellerId }, dto)
      return dto
    },
  }
}
