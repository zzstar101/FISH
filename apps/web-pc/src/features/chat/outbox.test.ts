import { describe, expect, test } from 'bun:test'
import type { MediaMessageDto, MessageDto } from '@fish/contracts/chat/schema'
import { ApiError } from '../../lib/api-client'
import type { MediaUploadDraft } from './media'
import {
  createMediaOutboxMessage,
  createOutboxMessage,
  dispatchMediaOutboxSend,
  dispatchOutboxSend,
  type OutboxMessage,
  type OutboxTextMessage,
  resetOutboxForRetry,
} from './outbox'
import type { SendMediaVariables, SendTextVariables } from './queries'

function mediaMessage(id: MediaMessageDto['id']): MediaMessageDto {
  return {
    id,
    conversationId: 'cnv_01jc000000e00800000000001a',
    senderId: 'usr_01jc000000e00800000000000a',
    kind: 'VOICE',
    mediaId: 'med_01jc000000e00800000000002a',
    url: `/api/conversations/cnv_01jc000000e00800000000001a/media/med_01jc000000e00800000000002a`,
    mimeType: 'audio/webm',
    sizeBytes: 2_048,
    width: null,
    height: null,
    durationMs: 1_500,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

function message(id: MessageDto['id'], content: string): MessageDto {
  return {
    id,
    conversationId: 'cnv_01jc000000e00800000000001a',
    senderId: 'usr_01jc000000e00800000000000a',
    sender: { id: 'usr_01jc000000e00800000000000a', nickname: '阿岚', avatarUrl: null },
    type: 'TEXT',
    content,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * 按 `useMutation` 返回对象的公开语义建模（见官方文档）：同一个 observer 连续
 * `mutate()` 时，**只有最新一次调用的 per-call 回调会执行**；`mutateAsync()` 每次
 * 调用返回自己的 Promise。用它来卡住「收尾跟着哪一次调用」这件事。
 */
function createMutationFake() {
  const requests = new Map<string, Deferred<MessageDto>>()
  let latestCall: {
    clientRequestId: string
    onError: (error: unknown) => void
    onSuccess: (message: MessageDto) => void
  } | null = null

  function start(variables: SendTextVariables): Deferred<MessageDto> {
    const request = deferred<MessageDto>()
    requests.set(variables.input.clientRequestId, request)
    return request
  }

  return {
    mutation: {
      mutate(
        variables: SendTextVariables,
        options: { onError: (error: unknown) => void; onSuccess: (message: MessageDto) => void },
      ) {
        const request = start(variables)
        const clientRequestId = variables.input.clientRequestId
        latestCall = { clientRequestId, ...options }
        request.promise.then(
          (value) => {
            if (latestCall?.clientRequestId === clientRequestId) latestCall.onSuccess(value)
          },
          (error: unknown) => {
            if (latestCall?.clientRequestId === clientRequestId) latestCall.onError(error)
          },
        )
      },
      mutateAsync(variables: SendTextVariables) {
        return start(variables).promise
      },
    },
    reject(clientRequestId: string, error: unknown) {
      requests.get(clientRequestId)?.reject(error)
    },
    resolve(clientRequestId: string, value: MessageDto) {
      requests.get(clientRequestId)?.resolve(value)
    },
  }
}

/**
 * 媒体发送的 fake：记录每次请求用的幂等键，用来验证「重试沿用同键」——
 * 服务端就是靠同一个 clientRequestId 才把重试认成重放而不是新消息。
 */
function createMediaMutationFake() {
  const requests = new Map<string, Deferred<MediaMessageDto>>()
  const seenClientRequestIds: string[] = []
  return {
    mutation: {
      mutateAsync(variables: SendMediaVariables) {
        seenClientRequestIds.push(variables.clientRequestId)
        const request = deferred<MediaMessageDto>()
        requests.set(variables.clientRequestId, request)
        return request.promise
      },
    },
    seenClientRequestIds,
    reject(clientRequestId: string, error: unknown) {
      requests.get(clientRequestId)?.reject(error)
    },
    resolve(clientRequestId: string, value: MediaMessageDto) {
      requests.get(clientRequestId)?.resolve(value)
    },
  }
}

const voiceDraft = (): MediaUploadDraft => ({
  kind: 'VOICE',
  file: new File(['voice-bytes'], 'voice.webm', { type: 'audio/webm' }),
  durationMs: 1_500,
})

/** 让 per-call 回调与 Promise 链各自跑完一轮微任务。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function createStore(initial: OutboxMessage[]) {
  let outbox = initial
  return {
    get outbox() {
      return outbox
    },
    setOutbox(update: (current: OutboxMessage[]) => OutboxMessage[]) {
      outbox = update(outbox)
    },
  }
}

describe('dispatchOutboxSend', () => {
  test('连续发送时每条 outbox 各自收敛，较早的不留在「发送中」', async () => {
    const fake = createMutationFake()
    const first = createOutboxMessage('第一条')
    const second = createOutboxMessage('第二条')
    const store = createStore([first, second])
    const sent: MessageDto[] = []

    void dispatchOutboxSend({
      item: first,
      conversationId: 'cnv_01jc000000e00800000000001a',
      mutation: fake.mutation,
      setOutbox: store.setOutbox,
      onSent: (value) => sent.push(value),
    })
    void dispatchOutboxSend({
      item: second,
      conversationId: 'cnv_01jc000000e00800000000001a',
      mutation: fake.mutation,
      setOutbox: store.setOutbox,
      onSent: (value) => sent.push(value),
    })

    // 反序返回：第二条先成功落地，第一条仍在途。
    fake.resolve(second.clientRequestId, message('msg_01jc000000e00800000000001w', '第二条'))
    await flush()
    expect(sent).toEqual([message('msg_01jc000000e00800000000001w', '第二条')])
    expect(store.outbox).toEqual([first])

    fake.reject(first.clientRequestId, new ApiError('CONVERSATION_NOT_FOUND', 404, 'nope'))
    await flush()
    expect(store.outbox).toEqual([
      {
        ...first,
        status: 'failed',
        error: '会话不存在或不可访问',
        errorCode: 'CONVERSATION_NOT_FOUND',
      },
    ])
  })

  test('按提交顺序返回时，先发出的那条同样各自收敛', async () => {
    const fake = createMutationFake()
    const first = createOutboxMessage('第一条')
    const second = createOutboxMessage('第二条')
    const store = createStore([first, second])
    const sent: string[] = []
    const input = (item: OutboxTextMessage) => ({
      item,
      conversationId: 'cnv_01jc000000e00800000000001a',
      mutation: fake.mutation,
      setOutbox: store.setOutbox,
      onSent: (value: MessageDto) => sent.push(value.id),
    })

    void dispatchOutboxSend(input(first))
    void dispatchOutboxSend(input(second))

    fake.resolve(first.clientRequestId, message('msg_01jc000000e00800000000001v', '第一条'))
    await flush()
    expect(sent).toEqual(['msg_01jc000000e00800000000001v'])
    expect(store.outbox).toEqual([second])

    fake.resolve(second.clientRequestId, message('msg_01jc000000e00800000000001w', '第二条'))
    await flush()
    expect(sent).toEqual(['msg_01jc000000e00800000000001v', 'msg_01jc000000e00800000000001w'])
    expect(store.outbox).toEqual([])
  })

  test('媒体重试沿用同一个幂等键，成功后才销账、不重复落条', async () => {
    const fake = createMediaMutationFake()
    const item = createMediaOutboxMessage(voiceDraft(), 'blob:preview-1')
    const store = createStore([item])
    const sent: MediaMessageDto[] = []
    const input = (current: typeof item) => ({
      item: current,
      conversationId: 'cnv_01jc000000e00800000000001a',
      mutation: fake.mutation,
      setOutbox: store.setOutbox,
      onSent: (value: MediaMessageDto) => sent.push(value),
    })

    void dispatchMediaOutboxSend(input(item))
    fake.reject(item.clientRequestId, new ApiError('MEDIA_OBJECT_NOT_FOUND', 422, '尚未上传完成'))
    await flush()
    expect(store.outbox).toEqual([
      {
        ...item,
        status: 'failed',
        error: '媒体上传未完成，请重试',
        errorCode: 'MEDIA_OBJECT_NOT_FOUND',
      },
    ])

    store.setOutbox((current) => resetOutboxForRetry(current, item.clientRequestId))
    const retrying = store.outbox[0]
    if (retrying === undefined || retrying.kind !== 'MEDIA') throw new Error('unreachable')
    expect(retrying.clientRequestId).toBe(item.clientRequestId)
    void dispatchMediaOutboxSend(input(retrying))

    fake.resolve(item.clientRequestId, mediaMessage('msg_01jc000000e00800000000001v'))
    await flush()
    expect(store.outbox).toEqual([])
    expect(sent.map((value) => value.id)).toEqual(['msg_01jc000000e00800000000001v'])
    // 两次请求（首次 + 重试）用同一个幂等键，服务端据此返回同一条而不是新建。
    expect(fake.seenClientRequestIds).toEqual([item.clientRequestId, item.clientRequestId])
  })

  test('重试沿用同一个幂等键，不新增待发条目', async () => {
    const fake = createMutationFake()
    const item = createOutboxMessage('重试我')
    const failed: OutboxMessage = {
      ...item,
      status: 'failed',
      error: '发送失败，请重试',
      errorCode: null,
    }
    const store = createStore([failed])
    const retrying: OutboxMessage = { ...failed, status: 'sending', error: null, errorCode: null }
    expect(resetOutboxForRetry(store.outbox, item.clientRequestId)).toEqual([retrying])

    void dispatchOutboxSend({
      item: retrying,
      conversationId: 'cnv_01jc000000e00800000000001a',
      mutation: fake.mutation,
      setOutbox: store.setOutbox,
      onSent: () => undefined,
    })
    fake.resolve(item.clientRequestId, message('msg_01jc000000e00800000000001v', '重试我'))
    await flush()
    expect(store.outbox).toEqual([])
  })
})
