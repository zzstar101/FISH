import { describe, expect, test } from 'bun:test'
import { clockTime, dayLabelOf } from '../src/lib/time'
import {
  canRetry,
  listingStatusText,
  type PendingMessage,
  parseTxEvent,
  systemPillText,
} from '../src/pages/conversation/view'

/**
 * 会话页（#89：历史 / 发送 / 已读接真实接口）的展示逻辑。
 *
 * 这里锁的是三类「界面上写什么」的判定：交易 SYSTEM 事件的中文化、时间文案、
 * 发送失败态能否重试。组件接线（页面是否调用、传什么参数）靠 code review。
 */

describe('parseTxEvent —— 交易 SYSTEM 事件解析', () => {
  test('认得出契约里的 tx.* JSON', () => {
    expect(parseTxEvent(JSON.stringify({ type: 'tx.proposal', amountCents: 15000 }))).toEqual({
      type: 'tx.proposal',
    })
  })

  test('普通文本系统消息、缺 type、type 非字符串都返回 null（按原文渲染）', () => {
    expect(parseTxEvent('你的学号认证已通过')).toBeNull()
    expect(parseTxEvent(JSON.stringify({ amountCents: 1 }))).toBeNull()
    expect(parseTxEvent(JSON.stringify({ type: 42 }))).toBeNull()
    expect(parseTxEvent('{"type":')).toBeNull()
  })
})

describe('systemPillText —— 灰胶囊文案', () => {
  test('proposal / rejected 翻成中文', () => {
    expect(systemPillText(JSON.stringify({ type: 'tx.proposal' }))).toBe('待对方同意')
    expect(systemPillText(JSON.stringify({ type: 'tx.rejected' }))).toBe('卖家已拒绝这次交易')
  })

  test('认不出的内容按原文降级，不吞消息', () => {
    expect(systemPillText(JSON.stringify({ type: 'tx.unknown' }))).toBe('{"type":"tx.unknown"}')
    expect(systemPillText('买家发起了交易确认。')).toBe('买家发起了交易确认。')
  })
})

describe('listingStatusText —— 商品摘要条状态', () => {
  test('契约的四种状态各有中文；缺字段说明商品已下架', () => {
    expect(listingStatusText('ACTIVE')).toBe('在售')
    expect(listingStatusText('RESERVED')).toBe('已预订')
    expect(listingStatusText('SOLD')).toBe('已售出')
    expect(listingStatusText('OFFLINE')).toBe('已下架')
    expect(listingStatusText(undefined)).toBe('商品已下架')
  })

  test('未来新增的状态原样透出，不假装成「在售」', () => {
    expect(listingStatusText('ARCHIVED')).toBe('ARCHIVED')
  })
})

describe('canRetry —— 发送失败才可重试', () => {
  test('failed 可以重试，sending 不能（避免重复投递）', () => {
    const failed: PendingMessage = { id: 'local-1', content: 'hi', status: 'failed' }
    const sending: PendingMessage = { id: 'local-2', content: 'hi', status: 'sending' }
    expect(canRetry(failed)).toBe(true)
    expect(canRetry(sending)).toBe(false)
  })
})

describe('clockTime —— 气泡时间戳', () => {
  test('本地时间 HH:mm，补零', () => {
    expect(clockTime(new Date(2026, 8, 21, 9, 5).toISOString())).toBe('09:05')
    expect(clockTime(new Date(2026, 8, 21, 23, 59).toISOString())).toBe('23:59')
  })

  test('解析不了 → 空串，不显示 NaN', () => {
    expect(clockTime('not-a-date')).toBe('')
  })
})

describe('dayLabelOf —— 日期分隔条', () => {
  // 固定「现在」为本地 2026-09-21 12:00（周一）
  const NOW = new Date(2026, 8, 21, 12, 0, 0).getTime()

  test('今天 / 昨天按本地日历日判定', () => {
    expect(dayLabelOf(new Date(2026, 8, 21, 9, 0).toISOString(), NOW)).toBe('今天 09:00')
    // 距今仅 16 小时，但日历上已经是昨天
    expect(dayLabelOf(new Date(2026, 8, 20, 20, 0).toISOString(), NOW)).toBe('昨天 20:00')
  })

  test('更早显示月日', () => {
    expect(dayLabelOf(new Date(2026, 8, 14, 10, 30).toISOString(), NOW)).toBe('9 月 14 日 10:30')
  })

  test('解析不了 → 空串', () => {
    expect(dayLabelOf('not-a-date', NOW)).toBe('')
  })
})
