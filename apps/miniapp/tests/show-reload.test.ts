import { describe, expect, test } from 'bun:test'
import { isRecentlyLoaded, SHOW_RELOAD_MIN_INTERVAL_MS } from '../src/lib/show-reload'

/**
 * 「刚拉过吗」的判据（`useDidShow` 里那一道闸）。
 *
 * 锁三件事：①没成功加载过就一定不算「刚拉过」（首次进页 / 上次失败都要真拉一次）；
 * ②窗口内算刚拉过；③拿不准（时钟回拨）时不算 —— 宁可多一次请求，不能让用户停在
 * 旧数据上等 30 秒。
 */
describe('刚拉过吗（回到本页是否跳过重拉）', () => {
  test('窗口是 30 秒', () => {
    expect(SHOW_RELOAD_MIN_INTERVAL_MS).toBe(30_000)
  })

  test('从没成功加载过（0）：不算刚拉过', () => {
    expect(isRecentlyLoaded(0, 1_700_000_000_000)).toBe(false)
  })

  test('脏值（负数 / NaN）当作没加载过', () => {
    expect(isRecentlyLoaded(-1, 1_700_000_000_000)).toBe(false)
    expect(isRecentlyLoaded(Number.NaN, 1_700_000_000_000)).toBe(false)
  })

  test('5 秒前刚拉过：算', () => {
    expect(isRecentlyLoaded(1_700_000_000_000, 1_700_000_005_000)).toBe(true)
  })

  test('差一点到 30 秒：算', () => {
    expect(isRecentlyLoaded(1_700_000_000_000, 1_700_000_029_999)).toBe(true)
  })

  test('正好 30 秒：不算（窗口是「至少隔这么久」）', () => {
    expect(isRecentlyLoaded(1_700_000_000_000, 1_700_000_030_000)).toBe(false)
  })

  test('一小时前：不算', () => {
    expect(isRecentlyLoaded(1_700_000_000_000, 1_700_003_600_000)).toBe(false)
  })

  test('时钟回拨（上次成功时刻在未来）：拿不准就不算，照常拉', () => {
    expect(isRecentlyLoaded(1_700_000_030_000, 1_700_000_000_000)).toBe(false)
  })

  test('同一时刻（elapsed 0）：算 —— 连续两次 show 只拉一次', () => {
    expect(isRecentlyLoaded(1_700_000_000_000, 1_700_000_000_000)).toBe(true)
  })

  test('窗口可传：判据本身不写死 30 秒', () => {
    expect(isRecentlyLoaded(1_700_000_000_000, 1_700_000_004_000, 5_000)).toBe(true)
    expect(isRecentlyLoaded(1_700_000_000_000, 1_700_000_005_000, 5_000)).toBe(false)
  })
})
