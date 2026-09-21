import { describe, expect, test } from 'bun:test'
import type { ConversationDto } from '@fish/contracts/chat/schema'
import {
  badgeText,
  chatListState,
  conversationTimeLabel,
  EMPTY_PREVIEW,
  previewOf,
} from '../src/pages/chat/list-view'

/**
 * 会话列表（#89：Chat 页从 fixture 改为真实 `GET /conversations`）。
 *
 * 这里锁的是「屏幕上显示的东西与事实不符」那一类缺陷：把「没读到」显示成
 * 「你没有会话」、把契约 JSON 原文当消息显示、把时间算成负数天。
 * 组件接线（页面是否调用这些函数、传什么参数）本仓没有组件渲染基建，靠 code review。
 */

function dto(overrides: Partial<ConversationDto> = {}): ConversationDto {
  return {
    id: 'c-1',
    listingId: 'l-1',
    role: 'buyer',
    listing: {
      id: 'l-1',
      title: 'K380 键盘',
      priceCents: 16000,
      status: 'ACTIVE',
      coverUrl: null,
    },
    counterpart: { id: 'u-2', nickname: '卖家', avatarUrl: null },
    unreadCount: 0,
    counterpartLastReadAt: null,
    lastMessage: null,
    lastMessageAt: '2026-09-21T04:00:00.000Z',
    createdAt: '2026-09-21T03:00:00.000Z',
    ...overrides,
  }
}

describe('badgeText —— 角标数字上限', () => {
  test('99 及以下原样显示，超过显示 99+', () => {
    expect(badgeText(0)).toBe('0')
    expect(badgeText(1)).toBe('1')
    expect(badgeText(99)).toBe('99')
    // 1版稿的窄角标装不下三位以上数字
    expect(badgeText(100)).toBe('99+')
    expect(badgeText(1234)).toBe('99+')
  })
})

describe('chatListState —— 列表形态判定', () => {
  test('失败 → 错误态，且优先于加载态与空态', () => {
    // 「加载不出来」不是「恰好没有会话」：即使还没 ready、条数为 0，也必须报错
    expect(chatListState({ ready: false, failed: true, itemCount: 0 })).toBe('error')
    expect(chatListState({ ready: true, failed: true, itemCount: 0 })).toBe('error')
    expect(chatListState({ ready: true, failed: true, itemCount: 5 })).toBe('error')
  })

  test('还没拿到结果 → 加载态，不能先显示空态', () => {
    // 首次进页 / 失败后重试在途：items 还是空数组，此时显示空态等于在说「你没有会话」
    expect(chatListState({ ready: false, failed: false, itemCount: 0 })).toBe('loading')
  })

  test('成功且为空 → 空态；成功且有数据 → 列表', () => {
    expect(chatListState({ ready: true, failed: false, itemCount: 0 })).toBe('empty')
    expect(chatListState({ ready: true, failed: false, itemCount: 1 })).toBe('list')
  })
})

describe('previewOf —— 列表行预览文案', () => {
  test('TEXT 直接显示原文', () => {
    const item = dto({
      lastMessage: {
        type: 'TEXT',
        content: '还在吗',
        senderId: 'u-2',
        createdAt: '2026-09-21T04:00:00.000Z',
      },
    })
    expect(previewOf(item)).toBe('还在吗')
  })

  test('还没有任何消息（lastMessage 为 null）→ 占位文案', () => {
    expect(previewOf(dto())).toBe(EMPTY_PREVIEW)
  })

  test('交易 SYSTEM 事件翻成中文，不把契约 JSON 漏到界面上', () => {
    const sys = (content: string) =>
      dto({
        lastMessage: {
          type: 'SYSTEM',
          content,
          senderId: null,
          createdAt: '2026-09-21T04:00:00.000Z',
        },
      })
    expect(previewOf(sys(JSON.stringify({ type: 'tx.proposal', amountCents: 15000 })))).toBe(
      '买家发起交易确认 · ¥150，待确认',
    )
    // 没有金额字段时不能显示 "¥undefined"
    expect(previewOf(sys(JSON.stringify({ type: 'tx.proposal' })))).toBe('买家发起交易确认，待确认')
    expect(previewOf(sys(JSON.stringify({ type: 'tx.accepted' })))).toBe('交易已确认 · 约定面交中')
    expect(previewOf(sys(JSON.stringify({ type: 'tx.rejected' })))).toBe('卖家已拒绝本次议价')
  })

  test('认不出的 SYSTEM 内容按原文降级（JSON 与普通文本都不吞）', () => {
    const sys = (content: string) =>
      dto({
        lastMessage: {
          type: 'SYSTEM',
          content,
          senderId: null,
          createdAt: '2026-09-21T04:00:00.000Z',
        },
      })
    expect(previewOf(sys(JSON.stringify({ type: 'tx.unknown' })))).toBe('{"type":"tx.unknown"}')
    expect(previewOf(sys('你的学号认证已通过'))).toBe('你的学号认证已通过')
  })
})

describe('conversationTimeLabel —— 会话行时间文案', () => {
  // 固定「现在」为本地 2026-09-21 12:00（周一），避免用例随时钟漂移
  const NOW = new Date(2026, 8, 21, 12, 0, 0).getTime()
  const at = (...args: [number, number, number, number?, number?]) =>
    new Date(...args).toISOString()

  test('一分钟内 → 刚刚；一小时内 → N 分钟前', () => {
    expect(conversationTimeLabel(new Date(NOW - 30_000).toISOString(), NOW)).toBe('刚刚')
    expect(conversationTimeLabel(new Date(NOW - 12 * 60_000).toISOString(), NOW)).toBe('12 分钟前')
  })

  test('同一天但超过一小时 → 今天（不是「N 小时前」）', () => {
    expect(conversationTimeLabel(at(2026, 8, 21, 9, 0), NOW)).toBe('今天')
  })

  test('昨天按本地日历日判定，不按「距今 24 小时」', () => {
    // 距今仅 16 小时，但日历上已经是昨天
    expect(conversationTimeLabel(at(2026, 8, 20, 20, 0), NOW)).toBe('昨天')
  })

  test('一周内 → 周X；超过一周 → M 月 D 日', () => {
    expect(conversationTimeLabel(at(2026, 8, 18, 10, 0), NOW)).toBe('周五')
    expect(conversationTimeLabel(at(2026, 8, 15, 10, 0), NOW)).toBe('周二')
    expect(conversationTimeLabel(at(2026, 8, 14, 10, 0), NOW)).toBe('9 月 14 日')
    expect(conversationTimeLabel(at(2026, 8, 1, 10, 0), NOW)).toBe('9 月 1 日')
  })

  test('未来时间戳（时钟偏差）夹到「刚刚」，不出负数', () => {
    expect(conversationTimeLabel(new Date(NOW + 60 * 60_000).toISOString(), NOW)).toBe('刚刚')
  })

  test('解析不了的 ISO → 空串（不显示 NaN）', () => {
    expect(conversationTimeLabel('not-a-date', NOW)).toBe('')
  })
})
