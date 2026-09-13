import { describe, expect, test } from 'bun:test'
import { createMessageService, MessageServiceError } from './service'
import type { ConversationParticipant, MessageRow, MessageStore } from './store'

const buyer = '00000000-0000-4000-8000-0000000000a1'
const seller = '00000000-0000-4000-8000-0000000000a2'
const outsider = '00000000-0000-4000-8000-0000000000a3'
const conversationA = '00000000-0000-4000-8000-0000000000c1'

export class MemoryMessageStore implements MessageStore {
  conversations = new Map<string, ConversationParticipant>([
    [conversationA, { id: conversationA, buyerId: buyer, sellerId: seller }],
  ])
  messages: MessageRow[] = []
  private seq = 0

  async findConversationForUser(conversationId: string, userId: string) {
    const conversation = this.conversations.get(conversationId)
    if (!conversation) return null
    if (userId !== conversation.buyerId && userId !== conversation.sellerId) return null
    return conversation
  }

  async listByConversation(
    conversationId: string,
    filter: { limit: number; before: string | null },
  ) {
    const all = this.messages
      .filter((row) => row.conversation_id === conversationId)
      // 与 SQL 同一排序键：(created_at DESC, id DESC)——同 created_at 的行也要有稳定顺序
      .sort(
        (a, b) =>
          String(b.created_at).localeCompare(String(a.created_at)) || b.id.localeCompare(a.id),
      )
    if (filter.before) {
      const index = all.findIndex((row) => row.id === filter.before)
      if (index === -1) return { kind: 'invalid-cursor' as const }
      // 与 SQL store 同一契约：返回**升序**的一页（含 limit+1 判底行）
      return { kind: 'ok' as const, rows: all.slice(index + 1, index + 2 + filter.limit).reverse() }
    }
    return { kind: 'ok' as const, rows: all.slice(0, filter.limit + 1).reverse() }
  }

  async insertText(conversationId: string, senderId: string, content: string) {
    const row: MessageRow = {
      id: `00000000-0000-4000-8000-${String(++this.seq).padStart(12, '0')}`,
      conversation_id: conversationId,
      sender_id: senderId,
      type: 'TEXT',
      content,
      created_at: new Date(`2026-09-12T10:00:0${this.seq}.000000Z`),
      sender_nickname: senderId === buyer ? '买家' : '卖家',
      sender_avatar_url: null,
    }
    this.messages.push(row)
    return row
  }

  async insertSystem(conversationId: string, content: string) {
    const row: MessageRow = {
      id: `00000000-0000-4000-8000-${String(++this.seq).padStart(12, '0')}`,
      conversation_id: conversationId,
      sender_id: null,
      type: 'SYSTEM',
      content,
      created_at: new Date(`2026-09-12T10:00:0${this.seq}.000000Z`),
      sender_nickname: null,
      sender_avatar_url: null,
    }
    this.messages.push(row)
    return row
  }
}

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
})
