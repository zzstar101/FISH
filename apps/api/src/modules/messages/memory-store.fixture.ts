import { MessageIdempotencyConflictError, type MessageSendKey } from './idempotency'
import type { ConversationParticipant, MessageRow, MessageStore } from './store'

/**
 * `MessageStore` 的内存替身（测试专用）。
 *
 * **为什么单独一个文件**：它此前 export 在 `messages/service.test.ts` 里，而
 * `transactions/service.test.ts` 为了复用它去 import 那个**测试文件** —— 于是 import 时
 * 连带执行了消息套件顶层的 `describe(...)`，消息用例在交易测试里被**重复注册并执行**，
 * 两套测试互相耦合、输出也变得难读（#40-5）。
 *
 * 文件名刻意不含 `test` / `spec`：Bun 的测试收集器不会把它当测试文件，因此只 import 它
 * 不会顺带注册任何用例。生产代码不 import 本文件。
 */

/** 替身内置身份：默认会话与 TEXT 消息的昵称映射都基于它们，测试里请引用这些常量。 */
export const MEMORY_BUYER_ID = '01930000-0000-7000-8000-0000000000a1'
export const MEMORY_SELLER_ID = '01930000-0000-7000-8000-0000000000a2'
export const MEMORY_OUTSIDER_ID = '01930000-0000-7000-8000-0000000000a3'
export const MEMORY_CONVERSATION_ID = '01930000-0000-7000-8000-0000000000c1'

export class MemoryMessageStore implements MessageStore {
  conversations = new Map<string, ConversationParticipant>([
    [
      MEMORY_CONVERSATION_ID,
      { id: MEMORY_CONVERSATION_ID, buyerId: MEMORY_BUYER_ID, sellerId: MEMORY_SELLER_ID },
    ],
  ])
  messages: MessageRow[] = []
  private seq = 0

  /** #67 幂等键 → 已落库消息与指纹（与 SQL 的部分唯一索引同语义）。 */
  private requestKeys = new Map<string, { requestHash: string; row: MessageRow }>()

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

  async insertText(
    conversationId: string,
    senderId: string,
    content: string,
    key?: MessageSendKey | null,
  ) {
    if (key) {
      const existing = this.requestKeys.get(requestKeyOf(senderId, conversationId, key))
      if (existing) {
        // 同键同指纹 = 重试，返回既有行；同键不同指纹 = 幂等键复用。
        if (existing.requestHash === key.requestHash) return existing.row
        throw new MessageIdempotencyConflictError(key.clientRequestId)
      }
    }
    const row: MessageRow = {
      id: `01930000-0000-7000-8000-${String(++this.seq).padStart(12, '0')}`,
      conversation_id: conversationId,
      sender_id: senderId,
      type: 'TEXT',
      content,
      created_at: new Date(`2026-09-12T10:00:0${this.seq}.000000Z`),
      sender_nickname: senderId === MEMORY_BUYER_ID ? '买家' : '卖家',
      sender_avatar_url: null,
    }
    this.messages.push(row)
    if (key) {
      this.requestKeys.set(requestKeyOf(senderId, conversationId, key), {
        requestHash: key.requestHash,
        row,
      })
    }
    return row
  }

  async insertSystem(conversationId: string, content: string) {
    const row: MessageRow = {
      id: `01930000-0000-7000-8000-${String(++this.seq).padStart(12, '0')}`,
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

const requestKeyOf = (senderId: string, conversationId: string, key: MessageSendKey): string =>
  `${senderId}|${conversationId}|${key.clientRequestId}`
