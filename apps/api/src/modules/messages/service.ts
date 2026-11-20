import {
  type ConversationListing,
  conversationListingSchema,
  type ListingMessageSendInput,
  MESSAGE_RECALL_WINDOW_MS,
  type MessageDto,
  type MessageListQuery,
  type MessageListResponse,
  type MessageSendInput,
  type MessageVisibility,
  messageDtoSchema,
  messageListResponseSchema,
} from '@fish/contracts/chat/schema'
import { isForeignKeyViolation } from '@fish/db/pg-errors'
import {
  decodePublicId,
  encodePublicId,
  isPublicId,
  PUBLIC_ID_PREFIX,
  type PublicId,
} from '@fish/shared/public-id'
import type { BlockRelationCheck } from '../blocks/store'
import type { ChatModerationPolicy, ChatModerationResult } from '../moderation/chat'
import { ContentModerationError } from '../moderation/providers/types'
import { publicAvatarUrl } from '../uploads/avatar-url'
import { isListingReviewMediaKey } from '../uploads/review-media'
import type { MediaStorage } from '../uploads/storage'
import {
  listingRequestHash,
  MessageIdempotencyConflictError,
  messageSendKey,
  textRequestHash,
} from './idempotency'
import { ReplyTargetInvalidError, resolveReplyTarget, toReply } from './reply'
import type {
  ChatModerationRecordInput,
  ListingBrief,
  MessageRow,
  MessageStore,
  ReplyTargetRow,
} from './store'

export class MessageServiceError extends Error {
  constructor(
    /** 503 只用于审核上游不可用（#694 M1 fail-closed）：消息未落库，可原样重试。 */
    readonly status: 403 | 404 | 409 | 422 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'MessageServiceError'
  }
}

const notFound = () => new MessageServiceError(404, 'CONVERSATION_NOT_FOUND', '会话不存在')

/** 引用目标不可用（不存在 / 不在本会话 / SYSTEM / 已撤回）。 */
const replyInvalid = () =>
  new MessageServiceError(422, 'MESSAGE_REPLY_INVALID', '被引用的消息不可引用')

/** 共享内核只抛类型化错误，这里翻成契约错误码（与 media 域同码，见 `./reply`）。 */
function translateReplyError(error: unknown): never {
  if (error instanceof ReplyTargetInvalidError) throw replyInvalid()
  throw error
}

/** 商品不存在 / 不可见统一 404：不区分两种原因（与 listings/users 的「不给状态空间开探针」同取舍）。 */
const listingNotFound = () =>
  new MessageServiceError(404, 'LISTING_NOT_FOUND', '商品不存在或不可见')

/** 同键不同内容：拒绝而不是静默返回旧消息，否则调用方会以为新内容已送达（丢消息）。 */
const idempotencyConflict = () =>
  new MessageServiceError(409, 'IDEMPOTENCY_KEY_REUSED', '同一个 clientRequestId 携带了不同内容')

/** 撤回失败的三档：不存在 / 不是本人 / 超窗口。 */
const recallNotFound = () => new MessageServiceError(404, 'MESSAGE_NOT_FOUND', '消息不存在')
const recallForbidden = () =>
  new MessageServiceError(403, 'MESSAGE_RECALL_FORBIDDEN', '只能撤回自己发送的消息')
const recallExpired = () =>
  new MessageServiceError(409, 'MESSAGE_RECALL_WINDOW_EXCEEDED', '超出可撤回时间')

/**
 * #694 M1：聊天审核必须显式给结论。BLOCK 不落消息行（与商品 422 同风格），
 * 上游故障一律 503——调用方可以原样重试，且此时库里没有任何可见/不可见的半成品。
 */
const contentBlocked = () =>
  new MessageServiceError(422, 'MESSAGE_CONTENT_BLOCKED', '消息包含不允许发送的内容')
const moderationUnavailable = () =>
  new MessageServiceError(503, 'CONTENT_MODERATION_UNAVAILABLE', '内容审核暂时不可用，请稍后重试')

/**
 * 审核结论 → 审计行（与消息同事务写入）。
 *
 * `machineDecision` 与 `decision` 在时间点 0 相同；人工复核只改 `decision`，保留机器原始结论。
 */
function moderationRecord(
  result: ChatModerationResult,
  status: 'PENDING' | 'SETTLED',
): ChatModerationRecordInput {
  return {
    kind: 'TEXT',
    decision: result.decision,
    machineDecision: result.decision,
    status,
    provider: result.provider,
    providerRequestId: result.providerRequestId,
    policyVersion: result.policyVersion,
    suggestion: result.suggestion,
    label: result.label,
    subLabel: result.subLabel,
    score: result.score,
    matchedRules: result.matchedRules,
    matchedTermsMasked: result.matchedTermsMasked,
  }
}

/**
 * 单条消息的引用投射（发送路径用；历史走 `enrichMessageRows` 的批量富化）。
 * `replyToId` 刚刚校验过，这里只补投射；查不到（并发删除）就退化为「无引用」，
 * 不让一次投射失败把已经落库的消息变成 500。
 */
async function withReply(
  store: MessageStore,
  dto: MessageDto,
  replyToId: string | null,
): Promise<MessageDto> {
  if (!replyToId) return dto
  // 存储层只返回 DELIVERED 的目标（#694 M1）：摘录会被广播给双方，待审正文不能进来。
  const target = (await store.findReplyTargets([replyToId])).get(replyToId)
  return target ? { ...dto, replyTo: toReply(target) } : dto
}

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
    // 撤回后正文**不再下发**（DB 保留审计）：客户端只该拿到撤回碑，不该拿到旧文本。
    content: row.recalled_at ? '' : row.content,
    recalledAt: row.recalled_at ? new Date(row.recalled_at).toISOString() : null,
    replyTo: null,
    listing,
    visibility: row.visibility,
    createdAt: new Date(row.created_at).toISOString(),
  })
}

/**
 * 一页消息统一富化（#359 3c）：有 `reply_to_id` 的行补 `replyTo` 引用块，其余行原样。
 * 引用目标批量查，避免对每条消息单独走一次查询。
 *
 * `listings` 是调用方先批量解出的本页商品投射（#359 商品卡）：两处富化共用同一次
 * `resolveListingProjections`，因此这里只查、不重复查商品。
 */
async function enrichMessageRows(
  store: MessageStore,
  rows: MessageRow[],
  projectContent: (type: string, content: string) => Promise<string>,
  listings: Map<string, ConversationListing>,
): Promise<MessageDto[]> {
  const replyIds = new Set<string>()
  for (const row of rows) {
    if (row.reply_to_id) replyIds.add(row.reply_to_id)
  }
  const replyTargets =
    replyIds.size > 0
      ? await store.findReplyTargets([...replyIds])
      : new Map<string, ReplyTargetRow>()

  return Promise.all(
    rows.map(async (row) => {
      const dto = toMessageDto(
        { ...row, content: await projectContent(row.type, row.content) },
        listings.get(row.id) ?? null,
      )
      const target = row.reply_to_id ? replyTargets.get(row.reply_to_id) : undefined
      return { ...dto, replyTo: target ? toReply(target) : null }
    }),
  )
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
  /** 撤回自己的消息（#359 3c）；幂等，重复撤回返回当前状态。 */
  recallMessage(userId: string, conversationId: string, messageId: string): Promise<void>
}

/**
 * 引用目标校验（#359 3c）。入参是契约里的**公开 id**（在 service 内解码成内部 uuid）：
 * 调用方（router）因此不需要知道内部 id 空间。
 * 判据在共享内核 `./reply`（media 域同一份），这里把它的错误翻成契约错误码。
 */
async function assertReplyTargetUsable(
  store: MessageStore,
  conversationId: string,
  replyToPublicId: string | undefined,
): Promise<string | null> {
  if (!replyToPublicId) return null
  // 形状不对（伪造前缀）与「不存在」同码：不把 id 空间当探针。
  if (!isPublicId(PUBLIC_ID_PREFIX.message, replyToPublicId)) throw replyInvalid()
  try {
    return await resolveReplyTarget(
      (ids) => store.findReplyTargets(ids),
      conversationId,
      decodePublicId(PUBLIC_ID_PREFIX.message, replyToPublicId),
    )
  } catch (error) {
    return translateReplyError(error)
  }
}

/**
 * #466 拉黑守卫（双向）：会话双方之间任一方向存在拉黑边，发送即被拦。
 * **中性码** `CONVERSATION_UNAVAILABLE` 对双方同码同文案，不暴露「谁拉黑了谁」。
 * 交易系统消息（SYSTEM）不走用户发送路径，天然不受影响。
 */
function makeBlockAssertion(blocks: BlockRelationCheck) {
  return async function assertNotBlocked(
    participants: { buyerId: string; sellerId: string },
    userId: string,
  ): Promise<void> {
    const other = participants.buyerId === userId ? participants.sellerId : participants.buyerId
    if (await blocks.existsBlockBetween(userId, other)) {
      throw new MessageServiceError(
        403,
        'CONVERSATION_UNAVAILABLE',
        '会话当前不可用，暂时无法发送消息',
      )
    }
  }
}

export function createMessageService({
  store,
  /** LISTING 卡片封面 URL 的拼装（存储布局不进读模型，与 conversations 同一注入方式）。 */
  storage,
  /**
   * #466 拉黑守卫：**必填**。发送前判「会话双方之间任一方向存在拉黑边」，漏接线等于
   * 守卫失效，所以在类型层要求装配方显式提供。
   */
  blocks,
  /**
   * #694 M1 聊天内容安全：**必填**。文字消息在写库前送审；漏接线等于聊天无审核，
   * 所以在类型层要求装配方显式提供（与 `blocks` 同一取舍）。
   */
  chatModeration,
  /** 先落库再推送（#9 契约冻结语义）：消息持久化成功后调用；推送失败不得影响响应。 */
  onMessageCreated,
  /** 撤回落库后推送（#359 3c）：与 `message.new` 同一条「先落库再推送」语义。 */
  onMessageRecalled,
  projectContent = async (_type: string, content: string) => content,
}: {
  store: MessageStore
  storage: MediaStorage
  blocks: BlockRelationCheck
  chatModeration: ChatModerationPolicy
  projectContent?: (type: string, content: string) => Promise<string>
  onMessageCreated?: (
    participants: { buyerId: string; sellerId: string },
    message: MessageDto,
  ) => void
  onMessageRecalled?: (
    participants: { buyerId: string; sellerId: string },
    event: {
      conversationId: PublicId<'cnv'>
      messageId: PublicId<'msg'>
      recalledAt: string
      recalledBy: PublicId<'usr'>
    },
  ) => void
}): MessageService {
  const assertNotBlocked = makeBlockAssertion(blocks)

  return {
    async listMessages(userId, conversationId, query) {
      const conversation = await store.findConversationForUser(conversationId, userId)
      // 非参与者与不存在统一 404：不泄漏"会话存在但不是你的"。
      if (!conversation) throw notFound()

      const result = await store.listByConversation(conversationId, {
        limit: query.limit,
        before: query.before ?? null,
        viewerId: userId,
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
        items: await enrichMessageRows(store, page, projectContent, listings),
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
      // 引用不进指纹：同一正文 + 同一 clientRequestId 换引用目标是同一个发送请求的重试，
      // 重放既有行（含它当时的引用）才是「重试」的正确语义。
      const key = messageSendKey(input.clientRequestId, textRequestHash(content))
      // 重试快速路径（与媒体域同一取舍）：命中幂等键就**直接重放既有行**，先于引用目标校验
      // 与拉黑守卫。
      // 否则「第一次其实已落库、响应丢了」的重试会因为被引用那条此刻已撤回而撞 422
      // （消息早发出去了，客户端却以为没发成）。权威去重仍在 insertText 的事务里。
      /**
       * 幂等重放：同键且指纹一致就返回既有行。
       *
       * 三处使用：开头的快速路径、审核返回 BLOCK、审核上游失败。后两处是并发窗口的兜底
       * ——同键的第一次请求可能已经提交，第二次不该因为自己这一次拿到 BLOCK/503 就把
       * 「其实已投递」当成本次失败。
       */
      const replayCommitted = async (): Promise<MessageDto | null> => {
        if (!key) return null
        const replay = await store.findByRequestKey(conversationId, userId, key)
        if (!replay) return null
        if (!replay.matchedHash) throw idempotencyConflict()
        const dto = await withReply(store, toMessageDto(replay.row), replay.row.reply_to_id ?? null)
        // 只有已投递的消息才推送：待审消息的正文不能经 WebSocket 漏给接收者（#694 M1）。
        // 发送者拿到的是同一个 DTO（HTTP 响应），不需要再收一条推送。
        if (replay.row.visibility === 'DELIVERED') {
          onMessageCreated?.(
            { buyerId: conversation.buyerId, sellerId: conversation.sellerId },
            dto,
          )
        }
        return dto
      }
      const replayedBeforeModeration = await replayCommitted()
      if (replayedBeforeModeration) return replayedBeforeModeration
      /*
       * #466 拉黑守卫（双向）：放在幂等重放**之后**——「首发已落库、响应丢了」的重试必须
       * 重放既有行，否则客户端会把一条早已送达的消息当成本次发送失败（与上面「重放先于
       * 引用校验」同一顺序口径）。真正的新发送仍然在这里被拦下。
       */
      await assertNotBlocked(conversation, userId)
      // 引用目标先校验（#359 3c）：不可用直接 422，不落库。
      const replyToId = await assertReplyTargetUsable(store, conversationId, input.replyToId)

      /*
       * #694 M1：文字在**写可见消息之前**送审。
       *
       * - 上游调用不持事务、不持行锁（provider 层已有超时与有限重试）；
       * - BLOCK：不落消息行，直接 422（客户端改文案后应换一个 clientRequestId）；
       * - REVIEW：落 PENDING_REVIEW 行，只有发送者能读到，人工复核后再投递；
       * - ALLOW：落 DELIVERED 行，走原有的插入/幂等/推送路径；
       * - 上游异常：fail-closed 503，库里不留任何行——这是「没有结论就不放行」。
       */
      let moderation: ChatModerationResult
      try {
        moderation = await chatModeration.moderateText({ content })
      } catch (error) {
        // 并发窗口：同键的第一次可能已经提交，先重放；重放不到才 fail-closed。
        const replayed = await replayCommitted()
        if (replayed) return replayed
        /*
         * 任何上游拒绝（包括策略层未包装的异常）都转成 503：聊天审核没有「放行」的兜底
         * 分支。日志只记可诊断的元数据，不记正文与用户标识。
         */
        console.warn(
          '[chat-moderation] 审核失败，按 503 fail-closed',
          error instanceof ContentModerationError
            ? {
                provider: error.provider,
                reason: error.reason,
                requestId: error.requestId,
                httpCode: error.httpCode,
              }
            : {
                provider: 'unknown',
                reason: 'unexpected_error',
                errorName: error instanceof Error ? error.name : typeof error,
              },
        )
        throw moderationUnavailable()
      }
      if (moderation.decision === 'BLOCK') {
        // 并发窗口：同键第一次可能已经以 ALLOW 提交，重放而不是报 422。
        const replayed = await replayCommitted()
        if (replayed) return replayed
        /*
         * 机器 BLOCK 不落消息行（票面「不新增可见消息」），但审计不能因此丢结论：
         * 只打元数据，不打正文（#694 M1 日志纪律）。sender/conversation 也不打，
         * 避免日志成为可关联的私聊行为轨迹。
         */
        console.info('[chat-moderation] BLOCK', {
          provider: moderation.provider,
          policyVersion: moderation.policyVersion,
          requestId: moderation.providerRequestId,
          decision: moderation.decision,
          score: moderation.score,
        })
        throw contentBlocked()
      }
      const visibility: MessageVisibility =
        moderation.decision === 'REVIEW' ? 'PENDING_REVIEW' : 'DELIVERED'
      /*
       * 审核在途期间对方可能刚拉黑：进入送审前的守卫已经判过一次，这里必须再判一次
       * （送审是一次可能数百毫秒的网络往返），否则会投递一条「发送时未拉黑、投递时已
       * 拉黑」的消息。
       */
      await assertNotBlocked(conversation, userId)

      let row: MessageRow
      try {
        // 审核结论与消息同事务落库：ALLOW 直接 SETTLED，REVIEW 进人工队列。
        const record = moderationRecord(
          moderation,
          visibility === 'DELIVERED' ? 'SETTLED' : 'PENDING',
        )
        row = await store.insertText(
          conversationId,
          userId,
          content,
          visibility === 'DELIVERED'
            ? { key, replyToId, visibility: 'DELIVERED', moderation: record }
            : { key, replyToId, visibility, moderation: record },
        )
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
      // 投射按**行里的** `reply_to_id` 取（而不是本次请求的 `replyToId`）：并发下这里的
      // `insertText` 可能命中幂等键、返回的是既有行，行里记的才是权威的引用目标
      // （与媒体域 `media-service.ts` 的重放路径同口径）。新插入时两者本就相同。
      const dto = await withReply(store, toMessageDto(row), row.reply_to_id ?? null)
      // 先落库（上面已 await）再推送；推送失败由 hub 吞掉，不影响 201 响应。
      // 只有 DELIVERED 才推送：PENDING_REVIEW 若推给双方，正文会绕过读侧过滤直接到接收者。
      // 重试命中既有 DELIVERED 消息时也会推一次：契约明确「推送不保证不重不漏」，
      // 客户端按服务端 id 去重（#67 第三步）。
      if (row.visibility === 'DELIVERED') {
        onMessageCreated?.({ buyerId: conversation.buyerId, sellerId: conversation.sellerId }, dto)
      }
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
       * #466 拉黑守卫（双向）：与 TEXT 同序——幂等重放之后、真正落库之前。守卫拦的是
       * 新分享，不是「首发成功后的重试」。
       */
      await assertNotBlocked(conversation, userId)

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

    async recallMessage(userId, conversationId, messageId) {
      const conversation = await store.findConversationForUser(conversationId, userId)
      if (!conversation) throw notFound()
      const result = await store.recall(conversationId, messageId, userId, MESSAGE_RECALL_WINDOW_MS)
      if (result === 'not-found') throw recallNotFound()
      if (result === 'forbidden') throw recallForbidden()
      if (result === 'window-exceeded') throw recallExpired()
      /*
       * #694 M1：待审消息接收者从未见过它，撤回事件也不能成为侧信道（messageId 与时间戳）。
       * 未投递时只回推给发送者本人；同一 id 由 app 侧 Set 去重，不会重复下发。
       */
      const recipients =
        result.visibility === 'DELIVERED'
          ? { buyerId: conversation.buyerId, sellerId: conversation.sellerId }
          : { buyerId: userId, sellerId: userId }
      onMessageRecalled?.(recipients, {
        conversationId: encodePublicId(PUBLIC_ID_PREFIX.conversation, conversationId),
        messageId: encodePublicId(PUBLIC_ID_PREFIX.message, messageId),
        recalledAt: new Date(result.recalled_at as Date | string).toISOString(),
        recalledBy: encodePublicId(PUBLIC_ID_PREFIX.user, userId),
      })
    },
  }
}
