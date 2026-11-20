import { describe, expect, test } from 'bun:test'
import {
  notificationAppearance,
  notificationFeed,
} from '../src/features/notifications/presentation'
import type { MockNotification } from '../src/mock/types'

const now = new Date(2026, 10, 19, 1).getTime()
function notification(id: string, overrides: Partial<MockNotification> = {}): MockNotification {
  return {
    id,
    type: 'TX',
    payload: { event: 'PROPOSED' },
    createdAt: new Date(2026, 10, 18, 23).toISOString(),
    readAt: null,
    title: '交易进展',
    description: '买家发起了交易确认，等你接受',
    tone: 'warn',
    target: { kind: 'mylist', segment: 'pending' },
    ...overrides,
  }
}

describe('通知动态流', () => {
  test('突出最新可跳转的未读邀请，不丢失、不重复其余记录，也不修改输入顺序', () => {
    const older = notification('older', { createdAt: new Date(2026, 10, 17, 12).toISOString() })
    const latest = notification('latest')
    const alreadyRead = notification('read', { readAt: new Date(now).toISOString() })
    const noTarget = notification('no-target', { target: null })
    const items = [older, latest, alreadyRead, noTarget]
    const feed = notificationFeed(items, now)
    expect(feed.featured?.id).toBe('latest')
    const history = feed.groups.flatMap((group) => group.items.map((item) => item.id))
    expect(history).toHaveLength(3)
    expect(new Set(history)).toEqual(new Set(['older', 'read', 'no-target']))
    expect(items.map((item) => item.id)).toEqual(['older', 'latest', 'read', 'no-target'])
    expect(notificationFeed([alreadyRead], now).featured).toBeUndefined()
    expect(notificationFeed([], now).groups).toEqual([])
  })

  test('按日历日分组，午夜两侧虽不足 24 小时仍属于今天和昨天', () => {
    const history = [
      notification('yesterday', { readAt: '2026-11-18T16:00:00.000Z' }),
      notification('today', {
        type: 'MATCH',
        createdAt: new Date(2026, 10, 19, 0, 30).toISOString(),
      }),
      notification('earlier', {
        type: 'MATCH',
        createdAt: new Date(2026, 10, 17, 18).toISOString(),
      }),
      notification('same-day', {
        type: 'MATCH',
        createdAt: new Date(2026, 10, 18, 9).toISOString(),
      }),
    ]
    const { groups } = notificationFeed(history, now)
    expect(groups.map((group) => group.label)).toEqual(['今天', '昨天', '2 天前'])
    expect(groups[1]?.items.map((item) => item.id)).toEqual(['yesterday', 'same-day'])
  })

  test('语义标题与图标区分交易阶段，不能把未知事件或认证结果说成完成/通过', () => {
    const completed = notificationAppearance(
      notification('done', { payload: { event: 'COMPLETED' } }),
    )
    expect(completed.title).toBe('交易已完成')
    expect(completed.status).toBe('已完成')
    expect(completed.icon).toBe('checkCircleBrand')
    expect(
      notificationAppearance(notification('accepted', { payload: { event: 'ACCEPTED' } })).title,
    ).toBe('交易确认已接受')
    const unknown = notificationAppearance(notification('unknown', { payload: {} }))
    expect(unknown.title).toBe('交易进展')
    expect(unknown.status).toBeNull()
    const account = notificationAppearance(
      notification('account', {
        type: 'ACCOUNT',
        title: '校园认证',
        payload: { subject: 'VERIFICATION' },
      }),
    )
    expect(account.title).toBe('校园认证有更新')
    expect(account.variant).toBe('attention')

    const moderationApproved = notificationAppearance(
      notification('moderation-approved', {
        type: 'MODERATION',
        payload: { outcome: 'APPROVED' },
      }),
    )
    expect(moderationApproved.variant).toBe('success')

    const disputeResolved = notificationAppearance(
      notification('dispute-resolved', {
        type: 'DISPUTE',
        payload: { disputeEvent: 'RESOLVED' },
      }),
    )
    expect(disputeResolved.variant).toBe('success')
  })
})
