import type { MediaMessageDto, MediaPresignResponse, MessageDto } from '@fish/contracts/chat/schema'
import { ApiError } from '../../lib/api-client'
import { describeSendFailure } from './api'
import type { MediaUploadDraft } from './media'
import type { SendMediaVariables, SendTextVariables } from './queries'

/**
 * 本地待发气泡的状态。`clientRequestId` 同时是发给服务端的幂等键，
 * 因此重试必须沿用同一个值，不能重新生成。
 */
type OutboxBase = {
  clientRequestId: string
  status: 'sending' | 'failed'
  error: string | null
  errorCode: string | null
}

export type OutboxTextMessage = OutboxBase & {
  kind: 'TEXT'
  content: string
}

export type OutboxMediaMessage = OutboxBase & {
  kind: 'MEDIA'
  draft: MediaUploadDraft
  /** 本地预览用的 object URL；条目离场或页面卸载时 revoke。 */
  previewUrl: string
  /**
   * 首次预签名结果，重试**必须**复用。
   *
   * `objectKey` 参与服务端幂等指纹（`mediaRequestHash`），而 presign 每次都生成新 key：
   * 如果重试重新预签名，服务端会看到「同 clientRequestId + 不同指纹」，判成幂等键复用
   * （409）而不是重放既有消息 —— 响应丢失后的重试就永远拿不回那一条。
   *
   * 代价：`uploadUrl` 有有效期（本地 MinIO 为 10 分钟）。条目放很久后重试会卡在直传，
   * 此时移除本地记录重新发送即可；换取的是「重试绝不产生第二条消息」。
   */
  upload: MediaPresignResponse | null
}

export type OutboxMessage = OutboxTextMessage | OutboxMediaMessage

/**
 * 页面只需要「每次调用各自结算」的能力：接口收窄到 `mutateAsync`。
 * 若有人把它放宽回 `mutate(variables, { onSuccess, onError })`，outbox.test.ts 里
 * 按公开语义建模的 fake 会立刻把「较早的发送停在 sending」这条失败重新跑出来。
 */
export type OutboxSendMutation = {
  mutateAsync: (variables: SendTextVariables) => Promise<MessageDto>
}

export type OutboxMediaSendMutation = {
  mutateAsync: (variables: SendMediaVariables) => Promise<MediaMessageDto>
}

export function createOutboxMessage(content: string): OutboxTextMessage {
  return {
    kind: 'TEXT',
    clientRequestId: crypto.randomUUID(),
    content,
    status: 'sending',
    error: null,
    errorCode: null,
  }
}

export function createMediaOutboxMessage(
  draft: MediaUploadDraft,
  previewUrl: string,
): OutboxMediaMessage {
  return {
    kind: 'MEDIA',
    clientRequestId: crypto.randomUUID(),
    draft,
    previewUrl,
    upload: null,
    status: 'sending',
    error: null,
    errorCode: null,
  }
}

/** 预签名完成后落进 outbox：重试与后续渲染都从这条记录取 key。 */
export function attachMediaUpload(
  current: OutboxMessage[],
  clientRequestId: string,
  upload: MediaPresignResponse,
): OutboxMessage[] {
  return current.map((item) =>
    item.clientRequestId === clientRequestId && item.kind === 'MEDIA' ? { ...item, upload } : item,
  )
}

/** 发送成功：该条 outbox 离场，服务端消息由 onSent 落到缓存。 */
export function removeOutboxMessage(
  current: OutboxMessage[],
  clientRequestId: string,
): OutboxMessage[] {
  return current.filter((item) => item.clientRequestId !== clientRequestId)
}

/** 重试：沿用同一条目与同一个幂等键，只清掉上一次的失败态。 */
export function resetOutboxForRetry(
  current: OutboxMessage[],
  clientRequestId: string,
): OutboxMessage[] {
  return current.map((item) =>
    item.clientRequestId === clientRequestId
      ? { ...item, status: 'sending' as const, error: null, errorCode: null }
      : item,
  )
}

function markOutboxFailed(
  current: OutboxMessage[],
  clientRequestId: string,
  error: unknown,
): OutboxMessage[] {
  return current.map((item) =>
    item.clientRequestId === clientRequestId
      ? {
          ...item,
          status: 'failed' as const,
          error: describeSendFailure(error),
          errorCode: error instanceof ApiError ? error.code : null,
        }
      : item,
  )
}

/**
 * 把一次发送的收尾绑在**这次调用自己的 Promise** 上：成功先销账再落缓存
 * （onSent 里若抛错，这条也不能留在「发送中」），失败只标记这一条。
 */
function settleSend<TMessage>(input: {
  result: Promise<TMessage>
  clientRequestId: string
  setOutbox: (update: (current: OutboxMessage[]) => OutboxMessage[]) => void
  onSent: (message: TMessage) => void
}): Promise<void> {
  const { result, clientRequestId, setOutbox, onSent } = input
  return result.then(
    (message) => {
      setOutbox((current) => removeOutboxMessage(current, clientRequestId))
      onSent(message)
    },
    (error: unknown) => {
      setOutbox((current) => markOutboxFailed(current, clientRequestId, error))
    },
  )
}

/**
 * 不用 `mutation.mutate(variables, { onSuccess, onError })`：`useMutation` 返回的是同一
 * 个 observer，连续调用时 per-call 回调只对最新一次生效（官方语义见
 * https://tanstack.com/query/latest/docs/framework/react/reference/functions/useMutation），
 * 先发出去的请求返回时已经没人替它清 outbox，气泡会永久停在「发送中」，还可能与
 * 实时推送到达的同一条消息并存。`mutateAsync` 每次调用返回独立 Promise，N 条在途
 * 消息各自收敛；hook 级的列表/未读 invalidate 不受影响。
 */
export function dispatchOutboxSend(input: {
  item: OutboxTextMessage
  conversationId: string
  mutation: OutboxSendMutation
  setOutbox: (update: (current: OutboxMessage[]) => OutboxMessage[]) => void
  onSent: (message: MessageDto) => void
}): Promise<void> {
  const { item, conversationId, mutation, setOutbox, onSent } = input
  const variables: SendTextVariables = {
    conversationId,
    input: { content: item.content, clientRequestId: item.clientRequestId },
  }
  return settleSend({
    result: mutation.mutateAsync(variables),
    clientRequestId: item.clientRequestId,
    setOutbox,
    onSent,
  })
}

/**
 * 媒体发送：与文本同一套重试语义，但预签名只做一次。
 *
 * 首次尝试先 presign 并把结果写回 outbox；重试直接用记录里的同一个 `objectKey`
 * （见 `OutboxMediaMessage.upload`），保证服务端幂等指纹不变、命中重放。
 */
export function dispatchMediaOutboxSend(input: {
  item: OutboxMediaMessage
  conversationId: string
  mutation: OutboxMediaSendMutation
  presign: (conversationId: string, draft: MediaUploadDraft) => Promise<MediaPresignResponse>
  setOutbox: (update: (current: OutboxMessage[]) => OutboxMessage[]) => void
  onSent: (message: MediaMessageDto) => void
}): Promise<void> {
  const { item, conversationId, mutation, presign, setOutbox, onSent } = input
  const upload =
    item.upload === null
      ? presign(conversationId, item.draft).then((result) => {
          setOutbox((current) => attachMediaUpload(current, item.clientRequestId, result))
          return result
        })
      : Promise.resolve(item.upload)

  const variables = upload.then<SendMediaVariables>((resolved) => ({
    conversationId,
    draft: item.draft,
    upload: resolved,
    clientRequestId: item.clientRequestId,
  }))

  return settleSend({
    result: variables.then((value) => mutation.mutateAsync(value)),
    clientRequestId: item.clientRequestId,
    setOutbox,
    onSent,
  })
}
