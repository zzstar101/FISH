import { describe, expect, test } from 'bun:test'
import { relativeTimeOf } from '../src/lib/time'

/**
 * 「等了多久」（`relativeTimeOf`）。我的发布的待确认行用它渲染「小北 点了「我想要」 · 2 小时前」。
 *
 * 三组边界值得锁：
 *
 * 1. **一天以内按时长**（分钟 / 小时档，向下取整），**超过一天才按本地日历日**判
 *    昨天 / N 天前 —— 所以「23:30 的提案在次日 00:30」是「1 小时前」而不是「昨天」：
 *    这才是用户想要的精确度；
 * 2. **未来时间戳**（两端时钟偏差）夹到 0 走「刚刚」，绝不出现「-3 分钟前」；
 * 3. **坏输入不抛错**，返回空串让页面自己决定怎么退化。
 *
 * `nowMs` 由调用方传入（`lib/time.ts` 的约定），所以这里所有用例都是确定性的。
 */
describe('relativeTimeOf —— 「等了多久」', () => {
  const MIN = 60_000

  test('不足 1 分钟 → 刚刚；分钟 / 小时按档位向下取整', () => {
    const now = Date.parse('2026-09-24T12:00:00.000Z')
    expect(relativeTimeOf('2026-09-24T11:59:30.000Z', now)).toBe('刚刚')
    expect(relativeTimeOf('2026-09-24T11:58:00.000Z', now)).toBe('2 分钟前')
    expect(relativeTimeOf('2026-09-24T09:00:00.000Z', now)).toBe('3 小时前')
    // 59 分钟仍是分钟档，恰好 60 分钟才进小时档
    expect(relativeTimeOf(new Date(now - 59 * MIN).toISOString(), now)).toBe('59 分钟前')
    expect(relativeTimeOf(new Date(now - 60 * MIN).toISOString(), now)).toBe('1 小时前')
  })

  test('一天以内一律按时长：跨了日历日但只差 1 小时，仍说「1 小时前」', () => {
    /*
     * 「昨天」只在**超过 24 小时**时才出现（那时才按日历日差算天数）。
     * 这两个时刻按本地时区构造，用例在任何时区下都成立。
     */
    const late = new Date(2026, 8, 23, 23, 30)
    const early = new Date(2026, 8, 24, 0, 30)
    expect(early.getTime() - late.getTime()).toBe(60 * MIN)
    expect(relativeTimeOf(late.toISOString(), early.getTime())).toBe('1 小时前')

    // 满 24 小时才进「昨天」
    const noon = new Date(2026, 8, 24, 12, 0)
    expect(relativeTimeOf(new Date(2026, 8, 23, 12, 0).toISOString(), noon.getTime())).toBe('昨天')
  })

  test('超过一天按本地日历日差算（2 天前 / 3 天前）', () => {
    const now = new Date(2026, 8, 24, 12, 0).getTime()
    expect(relativeTimeOf(new Date(2026, 8, 22, 12, 0).toISOString(), now)).toBe('2 天前')
    expect(relativeTimeOf(new Date(2026, 8, 21, 12, 0).toISOString(), now)).toBe('3 天前')
  })

  test('未来时间戳（两端时钟偏差）夹到 0 走「刚刚」，不出现负数', () => {
    const now = Date.parse('2026-09-24T12:00:00.000Z')
    expect(relativeTimeOf('2026-09-24T12:05:00.000Z', now)).toBe('刚刚')
  })

  test('坏输入返回空串（页面自己决定退化），不抛错', () => {
    expect(relativeTimeOf('不是时间', Date.now())).toBe('')
  })
})
