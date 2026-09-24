import { describe, expect, test } from 'bun:test'
import {
  MEMORY_BUYER_ID as buyer,
  MEMORY_CONVERSATION_ID as conversationA,
  MemoryMessageStore,
  MEMORY_OUTSIDER_ID as outsider,
  MEMORY_SELLER_ID as seller,
} from './memory-store.fixture'
import { createMessageService, MessageServiceError } from './service'

describe('message service: listMessages', () => {
  test('returns ascending messages with sender info', async () => {
    const store = new MemoryMessageStore()
    const first = await store.insertText(conversationA, buyer, '在吗')
    const second = await store.insertText(conversationA, seller, '在的')
    const service = createMessageService({ store })
    const result = await service.listMessages(buyer, conversationA, { limit: 30 })
    expect(result.items.map((item) => item.id)).toEqual([first.id, second.id])
    expect(result.items[0]?.sender?.nickname).toBe('买家')
    expect(result.nextCursor).toBeNull()
  })

  test('404 CONVERSATION_NOT_FOUND for a non-participant (不泄漏存在性)', async () => {
    const service = createMessageService({ store: new MemoryMessageStore() })
    expect(service.listMessages(outsider, conversationA, { limit: 30 })).rejects.toMatchObject({
      status: 404,
      code: 'CONVERSATION_NOT_FOUND',
    })
  })

  test('422 on a cursor that does not belong to the conversation', async () => {
    const store = new MemoryMessageStore()
    await store.insertText(conversationA, buyer, '在吗')
    const service = createMessageService({ store })
    expect(
      service.listMessages(buyer, conversationA, {
        limit: 30,
        before: '00000000-0000-4000-8000-0000000000ff',
      }),
    ).rejects.toMatchObject({ status: 422, code: 'VALIDATION_FAILED' })
  })

  test('cursor pagination walks backwards through history', async () => {
    const store = new MemoryMessageStore()
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push((await store.insertText(conversationA, buyer, `m${i}`)).id)
    const service = createMessageService({ store })
    const [first, second, third] = ids
    if (!first || !second || !third) throw new Error('unreachable')

    const page1 = await service.listMessages(buyer, conversationA, { limit: 2 })
    expect(page1.items.map((item) => item.id)).toEqual([second, third])
    expect(page1.nextCursor).toBe(second)

    const page2 = await service.listMessages(buyer, conversationA, { limit: 2, before: second })
    expect(page2.items.map((item) => item.id)).toEqual([first])
    expect(page2.nextCursor).toBeNull()
  })
})

describe('message service: sendTextMessage', () => {
  test('persists a TEXT message from the sender', async () => {
    const service = createMessageService({ store: new MemoryMessageStore() })
    const dto = await service.sendTextMessage(buyer, conversationA, { content: '  还在吗  ' })
    expect(dto.type).toBe('TEXT')
    expect(dto.content).toBe('还在吗')
    expect(dto.sender?.id).toBe(buyer)
  })

  test('404 for a non-participant sender', async () => {
    const service = createMessageService({ store: new MemoryMessageStore() })
    expect(
      service.sendTextMessage(outsider, conversationA, { content: 'hello' }),
    ).rejects.toBeInstanceOf(MessageServiceError)
  })

  test('replays the stored message for a retried clientRequestId（同键同内容）', async () => {
    const store = new MemoryMessageStore()
    const service = createMessageService({ store })
    const clientRequestId = '01990000-0000-7000-8000-0000000000f1'
    const first = await service.sendTextMessage(buyer, conversationA, {
      content: '还在吗',
      clientRequestId,
    })
    const retry = await service.sendTextMessage(buyer, conversationA, {
      content: '还在吗',
      clientRequestId,
    })
    expect(retry.id).toBe(first.id)
    expect(store.messages).toHaveLength(1)
  })

  test('重试内容仅差首尾空白：判为同一请求并重放（而不是 409）', async () => {
    // 指纹与落库都用 trim 后的正文，所以 'A ' 与 'A' 是**同一个**请求。若指纹改成对
    // 未 trim 的内容取哈希，这里会撞成 409 —— 这条用例专门把两种情况区分开。
    const store = new MemoryMessageStore()
    const service = createMessageService({ store })
    const clientRequestId = '01990000-0000-7000-8000-0000000000f3'
    const first = await service.sendTextMessage(buyer, conversationA, {
      content: 'A ',
      clientRequestId,
    })
    const retry = await service.sendTextMessage(buyer, conversationA, {
      content: 'A',
      clientRequestId,
    })
    expect(retry.id).toBe(first.id)
    expect(retry.content).toBe('A')
    expect(store.messages).toHaveLength(1)
  })

  test('同一 clientRequestId 携带不同内容 → 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const store = new MemoryMessageStore()
    const service = createMessageService({ store })
    const clientRequestId = '01990000-0000-7000-8000-0000000000f2'
    await service.sendTextMessage(buyer, conversationA, { content: 'A', clientRequestId })
    expect(
      service.sendTextMessage(buyer, conversationA, { content: 'B', clientRequestId }),
    ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' })
    expect(store.messages).toHaveLength(1)
  })
})
