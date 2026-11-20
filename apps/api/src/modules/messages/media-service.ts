import {
  MEDIA_IMAGE_MIME,
  MEDIA_MAX_IMAGE_BYTES,
  MEDIA_MAX_IMAGE_DIMENSION,
  MEDIA_MAX_VOICE_BYTES,
  type MediaKind,
  type MediaListQuery,
  type MediaListResponse,
  type MediaMessageDto,
  type MediaMessageInput,
  type MediaPresignInput,
  type MediaPresignResponse,
  type MessageReply,
  mediaListResponseSchema,
  mediaMessageDtoSchema,
  mediaPresignResponseSchema,
} from '@fish/contracts/chat/schema'
import { newId } from '@fish/db/ids'
import { isForeignKeyViolation } from '@fish/db/pg-errors'
import {
  decodePublicId,
  encodePublicId,
  isPublicId,
  PUBLIC_ID_PREFIX,
} from '@fish/shared/public-id'
import type { BlockRelationCheck } from '../blocks/store'
import type { ChatImageModerationResult, ChatModerationPolicy } from '../moderation/chat'
import { ContentModerationError } from '../moderation/providers/types'
import { CHAT_MEDIA_PREFIX, isSafeObjectKey, type MediaStorage } from '../uploads/storage'
import { MessageIdempotencyConflictError, mediaRequestHash, messageSendKey } from './idempotency'
import { probeImage } from './media-probe'
import type { MediaListCursor, MediaMessageStore, MediaRow } from './media-store'
import { ReplyTargetInvalidError, resolveReplyTarget, toReply } from './reply'
import type { ChatModerationRecordInput } from './store'

export class MediaMessageServiceError extends Error {
  constructor(
    readonly status: 403 | 404 | 409 | 422 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'MediaMessageServiceError'
  }
}

const notFound = () => new MediaMessageServiceError(404, 'CONVERSATION_NOT_FOUND', '会话不存在')
const invalid = (code: string, message: string) => new MediaMessageServiceError(422, code, message)
/** 语音审核上游未接入：显式关闭新发送，避免未审核音频直发。 */
const voiceDisabled = () =>
  new MediaMessageServiceError(
    422,
    'VOICE_SEND_DISABLED',
    '语音消息暂不支持发送：音频审核尚未接入，历史语音仍可正常播放',
  )
const contentBlocked = () =>
  new MediaMessageServiceError(422, 'MESSAGE_CONTENT_BLOCKED', '媒体内容未通过安全审核')
const moderationUnavailable = () =>
  new MediaMessageServiceError(
    503,
    'CONTENT_MODERATION_UNAVAILABLE',
    '内容审核暂不可用，请稍后重试',
  )
const idempotencyConflict = () =>
  new MediaMessageServiceError(
    409,
    'IDEMPOTENCY_KEY_REUSED',
    '同一个 clientRequestId 携带了不同内容',
  )

/** 按 kind 返回该类型允许的真实字节上限（防御纵深：presign 只校验客户端声明值）。 */
function maxBytesFor(kind: MediaKind): number {
  return kind === 'IMAGE' ? MEDIA_MAX_IMAGE_BYTES : MEDIA_MAX_VOICE_BYTES
}

/** 微秒精度 UTC ISO（DB 是 timestamptz 微秒）；JS Date 只有毫秒，不能用来生成游标。 */
const CURSOR_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/

function encodeMediaCursor(cursor: MediaListCursor): string {
  return Buffer.from(
    JSON.stringify({
      ...cursor,
      id: encodePublicId(PUBLIC_ID_PREFIX.message, cursor.id),
    }),
    'utf8',
  ).toString('base64url')
}

/**
 * 非法游标一律 422（与 listings / conversations 同一约定：不做宽容解析）。
 *
 * 只查形状还不够：手写正则放得过 `2026-13-45T99:99:99.999999Z`，随后被 PG 的
 * `::timestamptz` 拒绝 → 500。再做一次 Date round-trip（只比对到秒，微秒段交给 PG）。
 */
function decodeMediaCursor(raw: string): MediaListCursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    throw invalid('VALIDATION_FAILED', 'cursor 不合法')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalid('VALIDATION_FAILED', 'cursor 不合法')
  }
  const { createdAt, id } = parsed as Record<string, unknown>
  if (typeof createdAt !== 'string' || !CURSOR_TIMESTAMP_RE.test(createdAt)) {
    throw invalid('VALIDATION_FAILED', 'cursor 不合法')
  }
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 19) !== createdAt.slice(0, 19)) {
    throw invalid('VALIDATION_FAILED', 'cursor 不合法')
  }
  if (typeof id !== 'string' || !isPublicId(PUBLIC_ID_PREFIX.message, id)) {
    throw invalid('VALIDATION_FAILED', 'cursor 不合法')
  }
  return { createdAt, id: decodePublicId(PUBLIC_ID_PREFIX.message, id) }
}

export interface MediaMessageService {
  presign(
    userId: string,
    conversationId: string,
    input: MediaPresignInput,
  ): Promise<MediaPresignResponse>
  create(userId: string, conversationId: string, input: MediaMessageInput): Promise<MediaMessageDto>
  list(userId: string, conversationId: string, query: MediaListQuery): Promise<MediaListResponse>
  getObject(
    userId: string,
    conversationId: string,
    mediaId: string,
  ): Promise<{ key: string; contentType: string; size: number }>
}

const imageMime = (value: string): boolean =>
  (MEDIA_IMAGE_MIME as readonly string[]).includes(value)

/**
 * 媒体行 → DTO（#359 3c 起含撤回与引用）。
 *
 * 撤回后**不下发** url / 尺寸 / 时长：客户端只该渲染撤回碑，不该再去下载字节。
 * 字节仍在存储里（审计保留），所以这里只是读侧收敛，不是删除。
 */
function dto(
  row: MediaRow,
  baseUrl: (id: string) => string,
  replyTo: MessageReply | null = null,
): MediaMessageDto {
  const recalled = row.recalled_at !== null
  return mediaMessageDtoSchema.parse({
    id: encodePublicId(PUBLIC_ID_PREFIX.message, row.message_id),
    conversationId: encodePublicId(PUBLIC_ID_PREFIX.conversation, row.conversation_id),
    senderId: encodePublicId(PUBLIC_ID_PREFIX.user, row.sender_id),
    kind: row.kind,
    mediaId: encodePublicId(PUBLIC_ID_PREFIX.media, row.media_id),
    url: recalled ? '' : baseUrl(encodePublicId(PUBLIC_ID_PREFIX.media, row.media_id)),
    mimeType: row.mime_type,
    sizeBytes: recalled ? 0 : row.size_bytes,
    width: recalled ? null : row.width,
    height: recalled ? null : row.height,
    durationMs: recalled ? null : row.duration_ms,
    recalledAt: recalled ? new Date(row.recalled_at as Date | string).toISOString() : null,
    replyTo,
    visibility: row.visibility,
    createdAt: new Date(row.created_at).toISOString(),
  })
}

/**
 * #466 拉黑守卫（双向）：presign 与 create 共用同一谓词、同一中性码。
 *
 * 只挡 create 不够——被拉黑方仍能拿到 presign 的签名 URL 并把字节 PUT 进 storage
 * （create 才 403，消息不落库），在对象存储留下无主对象，且让「限制在服务端」落空。
 */
function makeBlockAssertion(blocks: BlockRelationCheck) {
  return async function assertNotBlocked(
    participants: { buyerId: string; sellerId: string },
    userId: string,
  ): Promise<void> {
    const other = participants.buyerId === userId ? participants.sellerId : participants.buyerId
    if (await blocks.existsBlockBetween(userId, other)) {
      throw new MediaMessageServiceError(
        403,
        'CONVERSATION_UNAVAILABLE',
        '会话当前不可用，暂时无法发送媒体',
      )
    }
  }
}

function moderationRecordOf(
  verdict: ChatImageModerationResult,
  delivered: boolean,
): ChatModerationRecordInput {
  return {
    kind: 'IMAGE',
    decision: verdict.decision,
    machineDecision: verdict.decision,
    status: delivered ? 'SETTLED' : 'PENDING',
    provider: verdict.provider,
    providerRequestId: verdict.providerRequestId,
    policyVersion: verdict.policyVersion,
    suggestion: verdict.suggestion,
    label: verdict.label,
    subLabel: verdict.subLabel,
    score: verdict.score,
    matchedRules: verdict.matchedRules,
    matchedTermsMasked: verdict.matchedTermsMasked,
  }
}

export function createMediaMessageService({
  store,
  storage,
  mediaUrl,
  blocks,
  chatModeration,
  onMediaCreated,
}: {
  store: MediaMessageStore
  storage: MediaStorage
  /** #694 M1：聊天图片在快照固化后送审；语音上游未接入，发送被显式关闭。 */
  chatModeration: ChatModerationPolicy
  mediaUrl: (conversationId: string, mediaId: string) => string
  /** #466 拉黑守卫：**必填**（与文本/商品卡同一谓词、同一中性码）。 */
  blocks: BlockRelationCheck
  onMediaCreated?: (
    participants: { buyerId: string; sellerId: string },
    media: MediaMessageDto,
  ) => void
}): MediaMessageService {
  const assertNotBlocked = makeBlockAssertion(blocks)
  /** 媒体行 → DTO；引用目标只取已投递的（与文本路径同一规则）。 */
  const toMediaDto = async (conversationId: string, row: MediaRow) => {
    const target = row.reply_to_id
      ? (await store.findReplyTargets([row.reply_to_id])).get(row.reply_to_id)
      : undefined
    return dto(
      row,
      (id) => mediaUrl(encodePublicId(PUBLIC_ID_PREFIX.conversation, conversationId), id),
      target ? toReply(target) : null,
    )
  }
  return {
    async presign(userId, conversationId, input) {
      const participant = await store.participant(conversationId, userId)
      if (!participant) throw notFound()
      await assertNotBlocked(participant, userId)
      // #694 M1：没有可用的音频审核上游时连上传地址都不发，避免留下永远不会被引用的字节。
      if (input.kind === 'VOICE') throw voiceDisabled()
      if (
        input.kind === 'IMAGE' &&
        (!imageMime(input.contentType) || input.sizeBytes > MEDIA_MAX_IMAGE_BYTES)
      ) {
        throw invalid('MEDIA_OBJECT_INVALID', '图片格式或大小不符合要求')
      }
      const extension = input.contentType.split('/')[1] ?? 'bin'
      const key = `chat-media/${encodePublicId(PUBLIC_ID_PREFIX.conversation, conversationId)}/${encodePublicId(PUBLIC_ID_PREFIX.user, userId)}/${encodePublicId(PUBLIC_ID_PREFIX.media, newId())}.${extension}`
      const signed = storage.presignPut({ key, contentType: input.contentType })
      return mediaPresignResponseSchema.parse({
        uploadUrl: signed.url,
        objectKey: key,
        headers: signed.headers,
        expiresAt: signed.expiresAt,
      })
    },
    async create(userId, conversationId, input) {
      const participant = await store.participant(conversationId, userId)
      if (!participant) throw notFound()
      // #67 幂等键：指纹取客户端**预签名 key** 与声明元数据；未携带键时为 null。
      const sendKey = messageSendKey(input.clientRequestId, mediaRequestHash(input))
      // 重试快速路径：命中幂等键直接返回既有媒体，跳过 stat / probe / 快照写入。否则每次
      // 重试都会往存储再写一份永远不会被引用的快照（同一个预签名 key 被客户端复用）。
      //
      // 已知取舍：指纹只含预签名 key + 声明元数据，不含对象字节，所以「同键、同声明元数据、
      // 但对象已被重新 PUT 成别的内容」会被当成重试而重放旧消息。要拦住它必须每次重试都
      // stat/probe/读全量字节 —— 那正是这条快速路径要避免的开销；且已交付的消息引用的是
      // 不可变快照，覆盖原 key 不会改变它指向的内容。
      if (sendKey) {
        const replay = await store.findByRequestKey(conversationId, userId, sendKey)
        if (replay) {
          if (!replay.matchedHash) throw idempotencyConflict()
          return toMediaDto(conversationId, replay.row)
        }
      }
      // #694 M1：语音审核上游未接入，显式关闭新语音发送（历史语音读取不受影响）。
      if (input.kind === 'VOICE') throw voiceDisabled()
      /*
       * #466 拉黑守卫（双向）：与文本/商品卡同一谓词、同一中性码
       * （CONVERSATION_UNAVAILABLE），且与 TEXT/LISTING 同序——幂等重放**之后**、引用目标
       * 校验与真正落库**之前**（对照 `service.ts:386-393`）。只拦新上传，不把「首发已落库
       * 后的重试」判成本次发送失败。
       */
      await assertNotBlocked(participant, userId)
      // 引用目标校验（#359 3c）：与 TEXT 路径同序，排在幂等重放与拉黑守卫**之后** ——
      // 否则「首发已落库、响应丢了」之后引用目标才被撤回的重试会撞 422，客户端把一条早已
      // 送达的消息当成发送失败。不可用直接 422，不做 stat / probe / 快照写入。
      let replyToId: string | null
      try {
        // 契约里 replyToId 是公开 id（与 listing 域的 `input.listingId` 同口径），
        // 在 service 内解码；形状不对与「不存在」同码。
        if (input.replyToId && !isPublicId(PUBLIC_ID_PREFIX.message, input.replyToId)) {
          throw new ReplyTargetInvalidError()
        }
        replyToId = await resolveReplyTarget(
          (ids) => store.findReplyTargets(ids),
          conversationId,
          input.replyToId ? decodePublicId(PUBLIC_ID_PREFIX.message, input.replyToId) : undefined,
        )
      } catch (error) {
        if (error instanceof ReplyTargetInvalidError) {
          throw invalid('MESSAGE_REPLY_INVALID', '被引用的消息不可引用')
        }
        throw error
      }
      const prefix = `chat-media/${encodePublicId(PUBLIC_ID_PREFIX.conversation, conversationId)}/${encodePublicId(PUBLIC_ID_PREFIX.user, userId)}/`
      if (!isSafeObjectKey(input.objectKey))
        throw invalid('MEDIA_OBJECT_INVALID', '媒体对象键不合法')
      const [mediaPart, mediaExtension, extra] = input.objectKey.slice(prefix.length).split('.')
      const isNewKey =
        input.objectKey.startsWith(prefix) &&
        isPublicId(PUBLIC_ID_PREFIX.media, mediaPart) &&
        mediaExtension === input.contentType.split('/')[1] &&
        extra === undefined
      if (!isNewKey) {
        const [conversations, users] = await Promise.all([
          store.legacyIds('conversations', conversationId),
          store.legacyIds('users', userId),
        ])
        const owned = [conversationId, ...conversations].some((conversation) =>
          [userId, ...users].some((user) =>
            input.objectKey.startsWith(`chat-media/${conversation}/${user}/`),
          ),
        )
        if (!owned) throw invalid('MEDIA_OBJECT_INVALID', '媒体不属于当前用户或会话')
      }
      const stat = await storage.stat(input.objectKey)
      if (!stat) throw invalid('MEDIA_OBJECT_NOT_FOUND', '媒体尚未上传完成')
      if (stat.size !== input.sizeBytes || stat.contentType !== input.contentType) {
        throw invalid('MEDIA_OBJECT_INVALID', '媒体实际属性与声明不一致')
      }
      // 防御纵深（评审 blocker 1）：presign 只校验客户端声明的 sizeBytes，而签名不约束
      // Content-Length，所以真实大小必须在这里基于 `stat.size` 再拦一次。否则可以先用
      // 1MB 声明拿 presign、实际上传 100MB，再在 create 时声明 100MB 落库。
      if (stat.size > maxBytesFor(input.kind)) {
        throw invalid('MEDIA_OBJECT_INVALID', '媒体大小超过限制')
      }
      // 服务端从对象内容解析真实尺寸 / 时长（fail-closed）：
      // 不信任客户端声明的 width/height/durationMs，解析失败或超出限制一律拒绝。
      if (!storage.readMediaBytes || !storage.writeMediaBytes) {
        throw invalid('MEDIA_OBJECT_INVALID', '存储未提供内容读取能力，无法完成服务端校验')
      }
      // 必须读**完整对象**：WebM 的 Duration 缺失时用文件尾的 Cluster Timecode，
      // MP4 的 moov 也可能在文件尾；只读头部会低估时长并绕过 60s 上限（评审 blocker 2）。
      const bytes = await storage.readMediaBytes(input.objectKey, maxBytesFor(input.kind))
      if (!bytes || bytes.length === 0) {
        throw invalid('MEDIA_OBJECT_INVALID', '媒体内容为空或不可读取')
      }
      if (bytes.length > maxBytesFor(input.kind) || bytes.length !== stat.size) {
        throw invalid('MEDIA_OBJECT_INVALID', '媒体大小超过限制或上传内容已变化')
      }
      // 保存已校验的同一份字节，而非重新读取/复制可被 PUT 覆盖的临时 key。
      const writeSnapshot = storage.writeMediaBytes
      const persist = async (verified: MediaMessageInput) => {
        const snapshotKey = `${CHAT_MEDIA_PREFIX}${conversationId}/${userId}/${newId()}`
        await writeSnapshot(snapshotKey, bytes, verified.contentType)
        const discardSnapshot = async () => {
          try {
            await storage.delete?.(snapshotKey)
          } catch {
            // 审核失败路径的清理是尽力而为：删不掉也不该把 422/503 变成 500。
          }
        }
        let visibility: 'DELIVERED' | 'PENDING_REVIEW' = 'DELIVERED'
        let moderation: ChatModerationRecordInput | undefined
        if (verified.kind === 'IMAGE') {
          try {
            const verdict = await chatModeration.moderateImage({ objectKey: snapshotKey })
            // 上游摘要必须与本地这份字节一致：否则无法证明「审的就是要发的那张图」。
            if (verdict.transport === 'tencent') {
              const localDigest = new Bun.CryptoHasher('md5').update(bytes).digest('hex')
              if (verdict.contentDigest !== localDigest) {
                throw new ContentModerationError({
                  reason: 'invalid_response',
                  provider: 'TENCENT_IMS',
                  detail: 'digest_mismatch',
                })
              }
            }
            if (verdict.decision === 'BLOCK') {
              await discardSnapshot()
              // BLOCK 不落消息行，但审计不能因此丢结论：只记元数据，不记对象键/正文。
              console.info('[chat-moderation] 图片 BLOCK', {
                provider: verdict.provider,
                policyVersion: verdict.policyVersion,
                requestId: verdict.providerRequestId,
                decision: verdict.decision,
                score: verdict.score,
              })
              // 并发同键：若另一请求已投递，重试应重放既有消息而不是报内容被拒。
              if (sendKey) {
                const replay = await store.findByRequestKey(conversationId, userId, sendKey)
                if (replay?.matchedHash) return toMediaDto(conversationId, replay.row)
              }
              throw contentBlocked()
            }
            visibility = verdict.decision === 'REVIEW' ? 'PENDING_REVIEW' : 'DELIVERED'
            moderation = moderationRecordOf(verdict, visibility === 'DELIVERED')
          } catch (error) {
            if (error instanceof MediaMessageServiceError) throw error
            await discardSnapshot()
            console.warn('[chat-moderation] 图片审核失败', {
              provider: error instanceof ContentModerationError ? error.provider : 'unknown',
              reason: error instanceof ContentModerationError ? error.reason : 'unknown',
              requestId: error instanceof ContentModerationError ? error.requestId : null,
              errorName: error instanceof Error ? error.name : typeof error,
            })
            throw moderationUnavailable()
          }
        }
        // 审核是一次网络往返，期间对方可能刚拉黑：送审前的守卫不够，落库前必须再判一次。
        await assertNotBlocked(participant, userId)
        let row: MediaRow
        try {
          const createOptions =
            visibility === 'DELIVERED'
              ? { key: sendKey, replyToId, visibility, moderation }
              : {
                  key: sendKey,
                  replyToId,
                  visibility,
                  moderation: moderation as ChatModerationRecordInput,
                }
          row = await store.create(
            conversationId,
            userId,
            { ...verified, objectKey: snapshotKey },
            createOptions,
          )
        } catch (error) {
          // 落库失败时这条快照永远不会被消息引用；顺手清掉，别把孤儿字节留给清理任务。
          await discardSnapshot()
          // 并发同键：store 已用 advisory lock 串行化并把重放读成既有行，这里只是把
          // 「同键不同内容」翻译成 409。
          if (error instanceof MessageIdempotencyConflictError) throw idempotencyConflict()
          // 会话在送审窗口被删：与文本路径同码，不把外键冲突暴露成 500。
          if (isForeignKeyViolation(error)) throw notFound()
          throw error
        }
        // 并发重放：另一个请求已经落库并拥有自己的快照，这一份刚写的字节没人引用。
        if (row.object_key !== snapshotKey) await discardSnapshot()
        const result = await toMediaDto(conversationId, row)
        // #694 M1：只有已投递的消息才推实时事件；待审只有发送者能通过 API 看到。
        const participants =
          row.visibility === 'DELIVERED' ? await store.participant(conversationId, userId) : null
        if (participants) onMediaCreated?.(participants, result)
        return result
      }
      if (input.kind === 'IMAGE') {
        const probed = probeImage(bytes, input.contentType)
        if (!probed) throw invalid('MEDIA_DIMENSION_EXCEEDED', '图片尺寸解析失败')
        if (probed.width > MEDIA_MAX_IMAGE_DIMENSION || probed.height > MEDIA_MAX_IMAGE_DIMENSION) {
          throw invalid('MEDIA_DIMENSION_EXCEEDED', '图片尺寸超过限制')
        }
        // 宽高**都要**与真实值对比（评审 F-2：旧代码只比 width，height 声明错了也放行）。
        if (input.width !== probed.width || input.height !== probed.height) {
          throw invalid('MEDIA_OBJECT_INVALID', '媒体尺寸与声明不一致')
        }
        // 用真实尺寸覆盖声明值，避免后端存的可能与客户端声明不一致。
        return persist({ ...input, width: probed.width, height: probed.height })
      }
      throw invalid('MEDIA_OBJECT_INVALID', '不支持的媒体类型')
    },
    async list(userId, conversationId, query) {
      if (!(await store.participant(conversationId, userId))) throw notFound()
      const cursor = query.cursor ? decodeMediaCursor(query.cursor) : null
      // store 返回**最新在前**（DESC）且多一条用于判断 hasMore；这里裁掉多出的一条，
      // 再把本页反转成时间正序返回（与 `GET /conversations/:id/messages` 同一约定：
      // 升序给前端，游标指向更早一页）。
      const rows = await store.list(conversationId, userId, { limit: query.limit, cursor })
      const hasMore = rows.length > query.limit
      const page = (hasMore ? rows.slice(0, query.limit) : rows).reverse()
      // 反转后最早的一条（page[0]）就是下一页游标。
      const oldest = page[0]
      const replyIds = [
        ...new Set(page.map((row) => row.reply_to_id).filter((id): id is string => !!id)),
      ]
      const targets = replyIds.length > 0 ? await store.findReplyTargets(replyIds) : new Map()
      return mediaListResponseSchema.parse({
        items: page.map((row) => {
          const target = row.reply_to_id ? targets.get(row.reply_to_id) : undefined
          return dto(
            row,
            (id) => mediaUrl(encodePublicId(PUBLIC_ID_PREFIX.conversation, conversationId), id),
            target ? toReply(target) : null,
          )
        }),
        nextCursor:
          hasMore && oldest
            ? encodeMediaCursor({ createdAt: oldest.created_at_iso, id: oldest.message_id })
            : null,
      })
    },
    async getObject(userId, conversationId, mediaId) {
      if (!(await store.participant(conversationId, userId))) throw notFound()
      const row = await store.find(conversationId, mediaId, userId)
      if (!row) throw new MediaMessageServiceError(404, 'MEDIA_NOT_FOUND', '媒体不存在')
      return { key: row.object_key, contentType: row.mime_type, size: row.size_bytes }
    },
  }
}
