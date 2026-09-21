import { describe, expect, test } from 'bun:test'
import { realCounts } from '../src/features/profile/counts'

/**
 * 「我的」页真实统计的未知态 —— 锁住 #127 review 的 P1：
 *
 * 修复前三个计数写成 `profile?.orderCount ?? 0` / `profile?.stats.activeWishes ?? 0` /
 * `profile?.stats.activeListings ?? 0`，于是 `/profile` 请求失败时页面把
 * 「全部订单 / 我的愿望 / 在售」显示成 0 —— 把「未知」说成「你没有」。
 *
 * 修复后未拿到 profile 一律 `null`（页面渲染 `—`、图标栏不出红点），
 * 只有接口明确返回 0 才是 0。
 */

/** 造一个「接口答上来了」的 profile 切片（只含本模块读的字段） */
function loaded(overrides: {
  orderCount?: number
  activeWishes?: number
  activeListings?: number
}): { orderCount: number; stats: { activeWishes: number; activeListings: number } } {
  return {
    orderCount: overrides.orderCount ?? 0,
    stats: {
      activeWishes: overrides.activeWishes ?? 0,
      activeListings: overrides.activeListings ?? 0,
    },
  }
}

describe('profile 统计未知态', () => {
  test('profile 为 null（未就绪 / 失败）→ 三个计数都是 null，不是 0', () => {
    expect(realCounts(null)).toEqual({
      activeWishes: null,
      orderCount: null,
      activeListings: null,
    })
  })

  test('接口明确返回 0 → 就是 0（区别于「不知道」）', () => {
    const counts = realCounts(loaded({ orderCount: 0, activeWishes: 0, activeListings: 0 }))

    // 0 与 null 在页面上表现不同：0 显示数字「0」且不出红点，
    // null 显示「—」——两者不能混为一谈
    expect(counts.orderCount).toBe(0)
    expect(counts.activeWishes).toBe(0)
    expect(counts.activeListings).toBe(0)
  })

  test('接口返回真实数字 → 原样透出', () => {
    const counts = realCounts(loaded({ orderCount: 12, activeWishes: 3, activeListings: 4 }))

    expect(counts).toEqual({ activeWishes: 3, orderCount: 12, activeListings: 4 })
  })
})
