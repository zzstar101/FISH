import { describe, expect, test } from 'bun:test'
import { formatMessageTime, systemMessageText } from './view'

describe('chat view helpers', () => {
  test('maps transaction system events without leaking raw JSON', () => {
    expect(systemMessageText('{"type":"tx.proposal","amountCents":16000}')).toBe('待对方同意')
    expect(
      systemMessageText(
        '{"type":"tx.accepted","transactionId":"01930000-0000-7000-8000-000000000051","amountCents":2800}',
      ),
    ).toBe('交易已接受，待面交')
    expect(systemMessageText('{"type":"tx.rejected"}')).toBe('卖家已拒绝这次交易')
    expect(systemMessageText('普通系统文本')).toBe('普通系统文本')
  })

  test('formats valid times and falls back for invalid input', () => {
    expect(formatMessageTime('2026-01-01T00:00:00.000Z')).toMatch(/^\d{2}:\d{2}$/)
    expect(formatMessageTime('not-a-date')).toBe('')
  })
})
