import { describe, expect, test } from 'bun:test'
import type { ViewHistoryItem } from '@fish/contracts/view-history/schema'
import {
  groupHistoryByDay,
  historyCountLabel,
  historyDayLabel,
  historyStatusView,
  localDayKey,
} from './view'

/**
 * 钉死时区再断言字面量结果：GitHub runner 默认 UTC，如果只在"本机是 UTC+8"的假设下
 * 现算期望值，实现误用 `getUTCDate` 之类的 UTC getter 在 CI 上也测不出来。
 * Bun 在运行时读取 `process.env.TZ`（实测：设 Asia/Shanghai 后 getDate() 从 1 变 2），
 * 且 `--isolate` 下每个测试文件有独立的 global/env 快照（实测同进程但不共享 env），
 * TZ 不会泄漏到其它文件。
 */
process.env.TZ = 'Asia/Shanghai'

function item(viewedAt: string, title = '商品'): ViewHistoryItem {
  return {
    listing: {
      id: 'lst_01jc000000e00800000000000k',
      title,
      priceCents: 100,
      category: 'OTHER',
      condition: 'GOOD',
      status: 'ACTIVE',
      urgent: false,
      negotiable: false,
      free: false,
      coverUrl: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      moderationStatus: null,
      wants: 0,
    },
    viewedAt,
  }
}

describe('localDayKey', () => {
  test('UTC 时间戳按本地日换算（钉死 Asia/Shanghai）', () => {
    // 2026-10-01T18:30Z 在 UTC+8 下是 10 月 2 日 02:30 —— 必须换算，不能照抄 UTC 日。
    expect(localDayKey('2026-10-01T18:30:00.000Z')).toBe('2026-10-02')
    // 同一天的 UTC 边界：15:59Z 仍是 10-01，16:00Z 起进入 10-02。
    expect(localDayKey('2026-10-01T15:59:59.999Z')).toBe('2026-10-01')
    expect(localDayKey('2026-10-01T16:00:00.000Z')).toBe('2026-10-02')
  })
})

describe('groupHistoryByDay', () => {
  test('相邻同日归一组，跨日开新组，组内保持输入顺序', () => {
    const groups = groupHistoryByDay([
      item('2026-10-02T03:00:00.000Z', 'A'),
      item('2026-10-02T02:00:00.000Z', 'B'),
      item('2026-10-01T03:00:00.000Z', 'C'),
    ])

    // 组的先后取决于输入顺序（服务端已按时间倒序），端上不重排。
    const [first, second] = groups
    expect(first?.items.map((entry) => entry.listing.title)).toEqual(['A', 'B'])
    expect(second?.items.map((entry) => entry.listing.title)).toEqual(['C'])
    expect(first?.date).not.toBe(second?.date)
  })

  test('空列表出空组', () => {
    expect(groupHistoryByDay([])).toEqual([])
  })
})

describe('historyDayLabel', () => {
  const now = new Date('2026-10-02T12:00:00')
  const today = localDayKey(now.toISOString())
  const yesterday = localDayKey(new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString())

  test('今天 / 昨天 / 同年日期 / 跨年日期', () => {
    expect(historyDayLabel(today, now)).toBe('今天')
    expect(historyDayLabel(yesterday, now)).toBe('昨天')
    expect(historyDayLabel('2026-09-12', now)).toBe('9月12日')
    expect(historyDayLabel('2025-12-31', now)).toBe('2025年12月31日')
  })
})

describe('historyStatusView', () => {
  test('四个状态各有自己的标签（失效原因由 status 承载）', () => {
    expect(historyStatusView('ACTIVE').label).toBe('在售')
    expect(historyStatusView('RESERVED').label).toBe('已预定')
    expect(historyStatusView('SOLD').label).toBe('已售出')
    expect(historyStatusView('OFFLINE').label).toBe('已下架')
  })
})

describe('historyCountLabel', () => {
  test('有数据出数字，未拿到/失败出「未知」而不是 0', () => {
    expect(historyCountLabel(3, false)).toBe(3)
    expect(historyCountLabel(0, false)).toBe(0)
    expect(historyCountLabel(undefined, false)).toBe('未知')
    expect(historyCountLabel(undefined, true)).toBe('未知')
    expect(historyCountLabel(5, true)).toBe('未知')
  })
})
