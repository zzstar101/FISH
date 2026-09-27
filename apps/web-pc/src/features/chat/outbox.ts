import type { MessageDto } from '@fish/contracts/chat/schema'
import { ApiError } from '../../lib/api-client'
import { describeSendFailure } from './api'
import type { SendTextVariables } from './queries'

/**
 * 本地待发气泡的状态。`clientRequestId` 同时是发给服务端的幂等键，
 * 因此重试必须沿用同一个值，不能重新生成。
 */
export type OutboxMessage = {
  clientRequestId: string
  content: string
  status: 'sending' | 'failed'
  error: string | null
  errorCode: string | null
}

/**
 * 页面只需要「每次调用各自结算」的能力：接口收窄到 `mutateAsync`。
 * 若有人把它放宽回 `mutate(variables, { onSuccess, onError })`，outbox.test.ts 里
 * 按公开语义建模的 fake 会立刻把「较早的发送停在 sending」这条失败重新跑出来。
 */
export type OutboxSendMutation = {
  mutateAsync: (variables: SendTextVariables) => Promise<MessageDto>
}

export function createOutboxMessage(content: string): OutboxMessage {
  return {
    clientRequestId: crypto.randomUUID(),
    content,
    status: 'sending',
    error: null,
    errorCode: null,
  }
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
 * 发起一次发送，并把这条 outbox 的收尾绑在**这次调用自己的 Promise** 上。
 *
 * 不用 `mutation.mutate(variables, { onSuccess, onError })`：`useMutation` 返回的是同一
 * 个 observer，连续调用时 per-call 回调只对最新一次生效（官方语义见
 * https://tanstack.com/query/latest/docs/framework/react/reference/functions/useMutation），
 * 先发出去的请求返回时已经没人替它清 outbox，气泡会永久停在「发送中」，还可能与
 * 实时推送到达的同一条消息并存。`mutateAsync` 每次调用返回独立 Promise，N 条在途
 * 消息各自收敛；hook 级的列表/未读 invalidate 不受影响。
 */
export function dispatchOutboxSend(input: {
  item: OutboxMessage
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
  return mutation.mutateAsync(variables).then(
    (message) => {
      // 先销账再落缓存：onSent 里若抛错，这条也不能留在「发送中」。
      setOutbox((current) => removeOutboxMessage(current, item.clientRequestId))
      onSent(message)
    },
    (error: unknown) => {
      setOutbox((current) => markOutboxFailed(current, item.clientRequestId, error))
    },
  )
}
