import { describe, expect, test } from 'bun:test'
import { watcherStatsOf } from '../src/features/watchers/stats'
import type { MockWatcher } from '../src/mock/types'

/**
 * 「想要的人」统计口径的回归测试 —— 锁住 #139 review 的两条 P1 里**可被单元测试锁住**的部分。
 *
 * 1. **统计人数必须等于列表行数**。修复前的算法排除了已注销的人（`!w.deactivated`），
 *    而列表把已注销的人照样渲染，于是页面同时出现「列表 8 行 / 共 7 人想要 /
 *    已显示全部 7 人」。用例 1、5 锁住新口径：已注销的人计入人数、也进中位数分母
 *    （对照：旧算法对含 1 条已注销的 3 行列表给 2，对 2 行给 1）。
 * 2. **拿不到数据时不能把「未知」显示成 0**。这一条在页面层（`statsUnknown` 把
 *    `failed` 表达成 `—`），本文件只负责「有数据时怎么算」—— 用例 4 锁住空列表
 *    返回 `count: 0`（「确实没人想要」），与「没读到」是两回事。
 *
 * ⚠️ 本文件**不覆盖**「页面是否真的把这份函数接上了」：那需要组件级测试。
 * 把页面改回旁路读 `watchersSummary()` 时，这些用例仍会全绿。
 */

function watcher(overrides: Partial<MockWatcher> = {}): MockWatcher {
  return {
    id: 'w-test',
    listingId: 'l-044',
    deactivated: false,
    nickname: '测试用户',
    avatarUrl: '',
    department: null,
    budgetCents: null,
    authStatus: 'UNVERIFIED',
    chattedCount: 0,
    timeLabel: '刚刚',
    ...overrides,
  }
}

describe('想要的人统计口径', () => {
  test('count 等于列表行数（已注销的人也算「想要的人」）', () => {
    const list = [
      watcher({ id: 'w-1' }),
      watcher({ id: 'w-2' }),
      watcher({ id: 'w-3', deactivated: true }),
    ]

    // 三条行 → 就是 3 个人。旧实现会返回 2（排除已注销），与列表行数不符。
    expect(watcherStatsOf(list).count).toBe(list.length)
  })

  test('中位数只按已填预算的人算，未填的人不进分母', () => {
    const list = [
      watcher({ id: 'w-1', budgetCents: 10000 }),
      watcher({ id: 'w-2', budgetCents: 30000 }),
      watcher({ id: 'w-3', budgetCents: null }),
    ]

    const stats = watcherStatsOf(list)
    expect(stats.budgetFilled).toBe(2)
    // (100 + 300) / 2 = 200 元 → 20000 分
    expect(stats.medianCents).toBe(20000)
    // 人数仍是全部 3 行
    expect(stats.count).toBe(3)
  })

  test('一个人都没填预算 → medianCents 为 null（暂缺），不是 0', () => {
    const stats = watcherStatsOf([watcher({ id: 'w-1' }), watcher({ id: 'w-2' })])

    expect(stats.medianCents).toBeNull()
    expect(stats.budgetFilled).toBe(0)
    expect(stats.count).toBe(2)
  })

  test('空列表 → 0 人、暂缺（这是「确实没人想要」，与「没读到」是两回事）', () => {
    expect(watcherStatsOf([])).toEqual({ count: 0, medianCents: null, budgetFilled: 0 })
  })

  test('已注销的人仍计入中位数（行上显示的预算与中位数的分母同一批）', () => {
    const list = [
      watcher({ id: 'w-1', budgetCents: 10000 }),
      watcher({ id: 'w-2', budgetCents: 30000, deactivated: true }),
    ]

    const stats = watcherStatsOf(list)
    expect(stats.budgetFilled).toBe(2)
    expect(stats.medianCents).toBe(20000)
  })
})
