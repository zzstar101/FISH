import { describe, expect, test } from 'bun:test'
import type { MessageDto } from '@fish/contracts/chat/schema'
import { excludeCachedMessages, formatMessageTime, systemMessageText } from './view'

function message(id: string): MessageDto {
  return {
    id,
    conversationId: 'conversation-1',
    senderId: 'user-a',
    sender: { id: 'user-a', nickname: '阿岚', avatarUrl: null },
    type: 'TEXT',
    content: id,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('chat view helpers', () => {
  test('maps transaction system events without leaking raw JSON', () => {
    expect(systemMessageText('{"type":"tx.proposal","amountCents":16000}')).toBe('交易确认待处理')
    expect(
      systemMessageText(
        '{"type":"tx.accepted","transactionId":"01930000-0000-7000-8000-000000000051","amountCents":2800}',
      ),
    ).toBe('交易已接受，待面交')
    expect(systemMessageText('{"type":"tx.rejected"}')).toBe('卖家已拒绝这次交易')
    expect(systemMessageText('{"type":"tx.proposal"}')).toBe('{"type":"tx.proposal"}')
    expect(systemMessageText('普通系统文本')).toBe('普通系统文本')
  })

  test('formats valid times and falls back for invalid input', () => {
    expect(formatMessageTime('2026-01-01T00:00:00.000Z')).toMatch(/^\d{2}:\d{2}$/)
    expect(formatMessageTime('not-a-date')).toBe('')
  })

  test('drops local messages already present in history so ids render once', () => {
    const local = [message('m1'), message('m2')]
    const history = [message('m2'), message('m3')]

    expect(excludeCachedMessages(local, history).map((item) => item.id)).toEqual(['m1'])
    expect(excludeCachedMessages([], history)).toEqual([])
  })
})
