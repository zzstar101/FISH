import { CHAT_ROUTES } from '@fish/contracts/chat/routes'
import {
  type ConversationDto,
  type ConversationListResponse,
  conversationDtoSchema,
  conversationListResponseSchema,
  conversationUnreadCountSchema,
  imageMediaMessageInputSchema,
  type MediaListResponse,
  type MediaMessageDto,
  type MediaPresignResponse,
  type MessageDto,
  type MessageListResponse,
  type MessageSendInput,
  mediaListResponseSchema,
  mediaMessageDtoSchema,
  mediaPresignInputSchema,
  mediaPresignResponseSchema,
  messageDtoSchema,
  messageListResponseSchema,
  voiceMediaMessageInputSchema,
} from '@fish/contracts/chat/schema'
import { TRANSACTION_ROUTES } from '@fish/contracts/transactions/routes'
import { ApiError, apiRequest } from '../../lib/api-client'
import { type MediaUploadDraft, resolveMediaContentType } from './media'

/** 契约里会话列表 limit 上限 50。 */
export const CONVERSATION_PAGE_LIMIT = 50
/** 契约里消息 limit 上限 100；首次加载取最新一页。 */
export const MESSAGE_PAGE_LIMIT = 100
/** 契约里媒体 limit 上限 100；首次加载取最新一页。 */
export const MEDIA_PAGE_LIMIT = 100

export function conversationListPath(cursor?: string): string {
  const params = new URLSearchParams()
  params.set('limit', String(CONVERSATION_PAGE_LIMIT))
  if (cursor !== undefined) params.set('cursor', cursor)
  return `${CHAT_ROUTES.base}?${params.toString()}`
}

export function messageListPath(conversationId: string, before?: string): string {
  const params = new URLSearchParams()
  params.set('limit', String(MESSAGE_PAGE_LIMIT))
  if (before !== undefined) params.set('before', before)
  return `${CHAT_ROUTES.messages(conversationId)}?${params.toString()}`
}

/** 媒体历史与文本历史是两个端点（`/messages` 明确排除 `type='MEDIA'`）。 */
export function mediaListPath(conversationId: string, cursor?: string): string {
  const params = new URLSearchParams()
  params.set('limit', String(MEDIA_PAGE_LIMIT))
  if (cursor !== undefined) params.set('cursor', cursor)
  return `${CHAT_ROUTES.media(conversationId)}?${params.toString()}`
}

/** 一页会话列表；cursor 是服务端下发的不透明字符串，前端只原样回传。 */
export async function fetchConversationPage(cursor?: string): Promise<ConversationListResponse> {
  return conversationListResponseSchema.parse(await apiRequest(conversationListPath(cursor)))
}

/** 创建或复用与商品卖家的会话（201 新建 / 200 复用都返回同一个 ConversationDto）。 */
export async function createConversation(listingId: string): Promise<ConversationDto> {
  return conversationDtoSchema.parse(
    await apiRequest(CHAT_ROUTES.base, {
      method: 'POST',
      body: JSON.stringify({ listingId }),
    }),
  )
}

/** 未读总数独立端点，不受列表分页影响。 */
export async function fetchConversationUnreadCount(): Promise<number> {
  const payload = await apiRequest(CHAT_ROUTES.unreadCount)
  return conversationUnreadCountSchema.parse(payload).unreadCount
}

/**
 * 会话详情。404 统一表示「不存在或当前账号不可访问」，用 null 让页面渲染业务空态，
 * 而不是把可预期状态当成错误页。
 */
export async function fetchConversation(conversationId: string): Promise<ConversationDto | null> {
  try {
    return conversationDtoSchema.parse(await apiRequest(CHAT_ROUTES.detail(conversationId)))
  } catch (error) {
    if (isConversationNotFound(error)) return null
    throw error
  }
}

/** 一页历史消息；契约按 (createdAt, id) 升序返回，before 为上一页最早消息 id。 */
export async function fetchMessagePage(
  conversationId: string,
  before?: string,
): Promise<MessageListResponse> {
  return messageListResponseSchema.parse(await apiRequest(messageListPath(conversationId, before)))
}

/** 一页媒体消息；契约按 (createdAt, id) 升序返回，cursor 由服务端下发、前端原样回传。 */
export async function fetchMediaPage(
  conversationId: string,
  cursor?: string,
): Promise<MediaListResponse> {
  return mediaListResponseSchema.parse(await apiRequest(mediaListPath(conversationId, cursor)))
}

/** 发 TEXT 消息；clientRequestId 由调用方为一次新发送生成，重试沿用。 */
export async function sendTextMessage(
  conversationId: string,
  input: MessageSendInput,
): Promise<MessageDto> {
  return messageDtoSchema.parse(
    await apiRequest(CHAT_ROUTES.messages(conversationId), {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  )
}

/**
 * 直传对象存储失败。与 ApiError 区分开，让 `describeSendFailure` 能给出
 * 「上传没走完」而不是笼统的「发送失败」。
 */
export class MediaUploadError extends Error {
  constructor() {
    super('媒体上传失败，请重试')
    this.name = 'MediaUploadError'
  }
}

/**
 * 媒体预签名：拿到对象存储的直传地址与 `objectKey`。
 *
 * **重试必须复用第一次的返回值**（见 `outbox.ts` 的 `upload` 字段）：`objectKey` 是服务端
 * 幂等指纹的一部分（`apps/api/src/modules/messages/idempotency.ts` 的 `mediaRequestHash`），
 * 每次重试都重新预签名会得到新 key，于是「同 clientRequestId + 不同指纹」被服务端判成
 * 幂等键复用（409），响应丢失后的重试就再也拿不回同一条消息。
 */
export async function presignMediaUpload(
  conversationId: string,
  draft: MediaUploadDraft,
): Promise<MediaPresignResponse> {
  const contentType = mediaContentType(draft)
  return mediaPresignResponseSchema.parse(
    await apiRequest(CHAT_ROUTES.mediaPresign(conversationId), {
      method: 'POST',
      body: JSON.stringify(
        mediaPresignInputSchema.parse({
          kind: draft.kind,
          contentType,
          sizeBytes: draft.file.size,
        }),
      ),
    }),
  )
}

/**
 * 上传与落库共用同一份 MIME（含「浏览器不给 MIME 时按扩展名回退」），
 * 两边不一致会被服务端的 stat 复核判成 MEDIA_OBJECT_INVALID。
 * 调用方在入 outbox 前已经过 `describeMediaFileRejection`，这里只是兜底。
 */
function mediaContentType(draft: MediaUploadDraft): string {
  const contentType = resolveMediaContentType(draft.kind, draft.file)
  if (contentType === null) throw new MediaUploadError()
  return contentType
}

/**
 * 第二、三段：客户端直传对象存储 → 创建媒体消息。
 *
 * 直传那一段**不能**走 `apiRequest`：它固定拼 `/api` 前缀并把响应当错误信封解析，
 * 而 `uploadUrl` 是对象存储的外域绝对地址（与 publish/api.ts 的图片上传同一先例）。
 * 幂等键由调用方为一次新发送生成，重试沿用同一个值。
 */
export async function sendMediaObject(
  conversationId: string,
  draft: MediaUploadDraft,
  presign: MediaPresignResponse,
  clientRequestId: string,
): Promise<MediaMessageDto> {
  const contentType = mediaContentType(draft)
  const uploaded = await fetch(presign.uploadUrl, {
    method: 'PUT',
    body: draft.file,
    headers: { ...presign.headers, 'content-type': contentType },
  })
  if (!uploaded.ok) throw new MediaUploadError()

  const input =
    draft.kind === 'IMAGE'
      ? imageMediaMessageInputSchema.parse({
          kind: 'IMAGE',
          objectKey: presign.objectKey,
          contentType,
          sizeBytes: draft.file.size,
          width: draft.width,
          height: draft.height,
          clientRequestId,
        })
      : voiceMediaMessageInputSchema.parse({
          kind: 'VOICE',
          objectKey: presign.objectKey,
          contentType,
          sizeBytes: draft.file.size,
          durationMs: draft.durationMs,
          clientRequestId,
        })

  return mediaMessageDtoSchema.parse(
    await apiRequest(CHAT_ROUTES.media(conversationId), {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  )
}

/** 首次发送：预签名 + 直传 + 创建。重试走 `sendMediaObject` 并复用首次的 presign。 */
export async function sendMediaMessage(
  conversationId: string,
  draft: MediaUploadDraft,
  clientRequestId: string,
): Promise<MediaMessageDto> {
  const presign = await presignMediaUpload(conversationId, draft)
  return sendMediaObject(conversationId, draft, presign, clientRequestId)
}

/** 标记会话已读，响应是同会话的未读归零 DTO。 */
export async function markConversationRead(conversationId: string): Promise<ConversationDto> {
  return conversationDtoSchema.parse(
    await apiRequest(CHAT_ROUTES.read(conversationId), { method: 'POST' }),
  )
}

export function isConversationNotFound(error: unknown): boolean {
  return (
    error instanceof ApiError && error.status === 404 && error.code === 'CONVERSATION_NOT_FOUND'
  )
}

/**
 * 撤回自己发的一条消息（#359 3c）：**204 无响应体**。
 *
 * 窗口 `MESSAGE_RECALL_WINDOW_MS`（2 分钟，按**数据库时钟**判）、仅发送者本人；
 * 对已撤回消息**幂等**（重复调用同样 204）。失败三档：
 * 404 `MESSAGE_NOT_FOUND`、403 `MESSAGE_RECALL_FORBIDDEN`、409 `MESSAGE_RECALL_WINDOW_EXCEEDED`。
 */
export async function recallMessage(conversationId: string, messageId: string): Promise<void> {
  await apiRequest(CHAT_ROUTES.recall(conversationId, messageId), { method: 'POST' })
}

/**
 * 撤回失败的展示文案：**用服务端原文**（与商品删除 #421、留言删除 #423 同一取向）。
 *
 * 三档原文本身就把话说清了（`apps/api/src/modules/messages/service.ts`）：
 * 「超出可撤回时间」/「只能撤回自己发送的消息」/「消息不存在」—— 端上再改写只会丢信息。
 */
export function describeRecallFailure(error: unknown): string {
  if (error instanceof ApiError) return error.message
  return '撤回失败，请重试'
}

/** 发起会话失败的展示文案；自聊由调用方决定隐藏入口。 */
export function describeCreateConversationFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'LISTING_NOT_FOUND') return '商品不存在或已下架'
    // #466 拉黑守卫（中性码）：不暴露「谁拉黑了谁」，只说会话当前不可用。
    if (error.code === 'CONVERSATION_UNAVAILABLE') return '会话当前不可用'
  }
  return '发起会话失败，请重试'
}

/** 发送失败的展示文案：只根据契约错误码分支，不把未知错误伪装成成功。 */
export function describeSendFailure(error: unknown): string {
  if (error instanceof MediaUploadError) return error.message
  if (error instanceof ApiError) {
    if (error.code === 'IDEMPOTENCY_KEY_REUSED') return '该次发送已用于其它内容'
    if (error.code === 'CONVERSATION_NOT_FOUND') return '会话不存在或不可访问'
    // #466 拉黑守卫（中性码，双向同文案）：会话被拉黑关系冻结，重试不会成功。
    if (error.code === 'CONVERSATION_UNAVAILABLE') return '会话当前不可用，暂时无法发送消息'
    if (error.code === 'VALIDATION_FAILED') return '消息内容不合法'
    // #67 媒体链路：上传未完成 / 内容与声明不符 / 超限 / 越权读取，逐条给明确反馈。
    if (error.code === 'MEDIA_OBJECT_NOT_FOUND') return '媒体上传未完成，请重试'
    if (error.code === 'MEDIA_OBJECT_INVALID') return '媒体文件与声明不一致，请重试'
    if (error.code === 'MEDIA_DURATION_EXCEEDED') return '语音不能超过 60 秒'
    if (error.code === 'MEDIA_DIMENSION_EXCEEDED') return '图片尺寸超过限制'
    if (error.code === 'MEDIA_NOT_FOUND') return '媒体不存在或不可访问'
    // #73 治理守卫：被封禁的账号在 media 路由上被 403 挡下，重试不会变成成功。
    if (error.code === 'USER_RESTRICTED') return '账号已被限制，暂不能发送消息'
    if (error.code === 'USER_GUARD_BUSY') return '操作繁忙，请稍后重试'
  }
  return '发送失败，请重试'
}

/**
 * 买家发起交易确认（`POST /transactions/proposals`）：往会话写一条 `tx.proposal` SYSTEM 消息，
 * 响应体就是那条消息，因此和发消息一样走 chat 的消息缓存。
 *
 * 商品仍是 `ACTIVE` —— 提案**不是商品状态**（契约注释同源）：只有卖家接受
 * （`POST /transactions`）才创建交易行并把商品置 `RESERVED`。
 *
 * `amountCents` 是议价结果，随提案带上；接受时以卖家重传的值为准（提案不落库，服务端无处可读）。
 */
export async function proposeTransaction(
  conversationId: string,
  amountCents: number,
): Promise<MessageDto> {
  return messageDtoSchema.parse(
    await apiRequest(TRANSACTION_ROUTES.proposals, {
      method: 'POST',
      body: JSON.stringify({ conversationId, amountCents }),
    }),
  )
}

/**
 * 发起交易确认失败的展示文案。
 *
 * `LISTING_NOT_ACTIVE` 标 `refresh: true`：商品被他人拍下或已下架是**状态漂移**，
 * 页面必须重新取详情，而不是把过期页面留在原地。
 */
export function describeProposeFailure(error: unknown): { message: string; refresh: boolean } {
  if (error instanceof ApiError) {
    if (error.code === 'LISTING_NOT_ACTIVE') {
      return { message: '商品已不在售，可能已被他人拍下', refresh: true }
    }
    if (error.code === 'NOT_CONVERSATION_BUYER') {
      return { message: '只有买家可以发起交易确认', refresh: false }
    }
    if (error.code === 'CONVERSATION_NOT_FOUND') {
      return { message: '会话不存在或不可访问', refresh: false }
    }
    if (error.code === 'VALIDATION_FAILED') {
      return { message: '金额不合法，请核对后重试', refresh: false }
    }
    return { message: error.message, refresh: false }
  }
  return { message: '发起交易确认失败，请重试', refresh: false }
}
