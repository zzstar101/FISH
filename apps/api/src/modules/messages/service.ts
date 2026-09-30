import {
  MESSAGE_RECALL_WINDOW_MS,
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
  type PublicId,
} from '@fish/shared/public-id'
import { publicAvatarUrl } from '../uploads/avatar-url'
import { MessageIdempotencyConflictError, messageSendKey, textRequestHash } from './idempotency'
import { ReplyTargetInvalidError, resolveReplyTarget, toReply } from './reply'
import type { MessageRow, MessageStore, ReplyTargetRow } from './store'

export class MessageServiceError extends Error {
  constructor(
    readonly status: 403 | 404 | 409 | 422,
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
  const target = (await store.findReplyTargets([replyToId])).get(replyToId)
  return target ? { ...dto, replyTo: toReply(target) } : dto
}

export function toMessageDto(row: MessageRow): MessageDto {
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
    createdAt: new Date(row.created_at).toISOString(),
  })
}

/**
 * 一页消息统一富化（#359 3c）：有 `reply_to_id` 的行补 `replyTo` 引用块，其余行原样。
 * 引用目标批量查，避免对每条消息单独走一次查询。
 */
async function enrichMessageRows(
  store: MessageStore,
  rows: MessageRow[],
  projectContent: (type: string, content: string) => Promise<string>,
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
      const dto = toMessageDto({ ...row, content: await projectContent(row.type, row.content) })
      const target = row.reply_to_id ? replyTargets.get(row.reply_to_id) : undefined
      return { ...dto, replyTo: target ? toReply(target) : null }
    }),
  )
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

export function createMessageService({
  store,
  /** 先落库再推送（#9 契约冻结语义）：消息持久化成功后调用；推送失败不得影响响应。 */
  onMessageCreated,
  /** 撤回落库后推送（#359 3c）：与 `message.new` 同一条「先落库再推送」语义。 */
  onMessageRecalled,
  projectContent = async (_type: string, content: string) => content,
}: {
  store: MessageStore
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
        items: await enrichMessageRows(store, page, projectContent),
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
      // 引用目标先校验（#359 3c）：不可用直接 422，不落库。
      const replyToId = await assertReplyTargetUsable(store, conversationId, input.replyToId)
      // #67 幂等键：指纹取 trim 后的正文（与落库的 content 同一值）；未携带键时为 null。
      // 引用不进指纹：同一正文 + 同一 clientRequestId 换引用目标是同一个发送请求的重试，
      // 重放既有行（含它当时的引用）才是「重试」的正确语义。
      const key = messageSendKey(input.clientRequestId, textRequestHash(content))
      let row: MessageRow
      try {
        row = await store.insertText(conversationId, userId, content, key, replyToId)
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
      const dto = await withReply(store, toMessageDto(row), replyToId)
      // 先落库（上面已 await）再推送；推送失败由 hub 吞掉，不影响 201 响应。
      // 重试命中既有消息时也会推一次：契约明确「推送不保证不重不漏」，客户端按服务端
      // id 去重（#67 第三步），这里不为去重再引入「新建/重放」的返回值分叉。
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
      onMessageRecalled?.(
        { buyerId: conversation.buyerId, sellerId: conversation.sellerId },
        {
          conversationId: encodePublicId(PUBLIC_ID_PREFIX.conversation, conversationId),
          messageId: encodePublicId(PUBLIC_ID_PREFIX.message, messageId),
          recalledAt: new Date(result.recalled_at as Date | string).toISOString(),
          recalledBy: encodePublicId(PUBLIC_ID_PREFIX.user, userId),
        },
      )
    },
  }
}
