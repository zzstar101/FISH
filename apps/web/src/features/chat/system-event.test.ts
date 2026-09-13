import { describe, expect, test } from 'bun:test'
import {
  formatMessageBody,
  formatSystemMessageBody,
  lastTransactionEvent,
  parseSystemEvent,
  TX_EVENT_BADGE,
} from './system-event'

/**
 * 会话行的交易状态胶囊完全靠这一层：`lastMessage` → `parseSystemEvent` → `TX_EVENT_BADGE`。
 * 契约把交易进展定义成 SYSTEM 消息（前缀 `tx.`），所以这里也是「交易状态从哪来」的回归网。
 */
describe('SYSTEM 消息（tx.*）', () => {
  test('解析 tx.proposal 并渲染成气泡文案', () => {
    const content = JSON.stringify({ type: 'tx.proposal', amountCents: 158000 })
    expect(parseSystemEvent(content)?.type).toBe('tx.proposal')
    expect(formatSystemMessageBody(content)).toContain('等待卖家接受')
  })

  test('解析 tx.accepted 并渲染成气泡文案', () => {
    const content = JSON.stringify({
      type: 'tx.accepted',
      transactionId: 't-1',
      amountCents: 158000,
    })
    expect(parseSystemEvent(content)?.type).toBe('tx.accepted')
    expect(formatSystemMessageBody(content)).toContain('卖家已接受交易')
    expect(formatSystemMessageBody(content)).toContain('待面交')
  })

  test('解析失败必须降级为原文，而不是抛错', () => {
    expect(parseSystemEvent('不是 JSON')).toBeNull()
    expect(parseSystemEvent('{"type":"tx.unknown"}')).toBeNull()
    expect(parseSystemEvent('null')).toBeNull()
    expect(formatSystemMessageBody('不是 JSON')).toBe('不是 JSON')
  })

  test('TEXT 直出，SYSTEM 先解析', () => {
    expect(formatMessageBody({ type: 'TEXT', content: '还在吗' })).toBe('还在吗')
    expect(formatMessageBody({ type: 'SYSTEM', content: '{"type":"tx.rejected"}' })).toBe(
      '卖家拒绝了本次交易确认',
    )
  })

  test('胶囊映射覆盖契约的全部三种事件（多一个少一个都会红）', () => {
    expect(Object.keys(TX_EVENT_BADGE).sort()).toEqual([
      'tx.accepted',
      'tx.proposal',
      'tx.rejected',
    ])
    expect(TX_EVENT_BADGE['tx.accepted']).toEqual({ label: '待面交', tone: 'lavender' })
    expect(TX_EVENT_BADGE['tx.proposal']).toEqual({ label: '待确认', tone: 'lavender' })
    expect(TX_EVENT_BADGE['tx.rejected']).toEqual({ label: '已拒绝', tone: 'secondary' })
  })

  test('lastTransactionEvent 从尾部找第一条可解析的 SYSTEM 消息，跳过 TEXT 与残缺内容', () => {
    const messages = [
      { type: 'SYSTEM' as const, content: '{"type":"tx.proposal","amountCents":100}' },
      { type: 'TEXT' as const, content: '在的' },
      { type: 'SYSTEM' as const, content: '残缺' },
    ]
    expect(lastTransactionEvent(messages)?.type).toBe('tx.proposal')
    expect(lastTransactionEvent([{ type: 'TEXT' as const, content: '在的' }])).toBeNull()
  })
})
