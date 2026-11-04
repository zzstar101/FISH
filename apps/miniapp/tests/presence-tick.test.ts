import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import {
  acquirePresenceClock,
  presenceNow,
  subscribePresenceNow,
} from '../src/features/presence/tick'
import { PRESENCE_TICK_MS } from '../src/features/presence/view'

/**
 * 共享时钟（`features/presence/tick`）的契约。
 *
 * 这个时钟只做一件事：每 `PRESENCE_TICK_MS` 把「现在」往前推一次并广播，让订阅它的
 * 那个绿点重算在线态（判定口径在 `presence-view.test.ts`）。这里锁的是**起停与广播的
 * 计数语义** —— 页面报前台就起、全走光才停，重复释放不许扣别人的持有权。
 *
 * 时钟是模块单例，所以每条用例自己占、自己放，收尾必须放干净（`beforeEach` 里再对一次
 * 表，避免上一条用例漏放把自己拖进来）。
 */
beforeEach(() => {
  jest.useFakeTimers()
})

afterEach(() => {
  jest.useRealTimers()
})

describe('presence tick —— 起表与广播', () => {
  test('占上的那一刻先对表并广播一次：回到前台的第一帧就是正确的「现在」', () => {
    const seen: number[] = []
    const off = subscribePresenceNow(() => seen.push(presenceNow()))
    const release = acquirePresenceClock()

    expect(seen).toEqual([Date.now()])
    expect(presenceNow()).toBe(Date.now())

    release()
    off()
  })

  test('每 PRESENCE_TICK_MS 前进一跳并广播一次', () => {
    const seen: number[] = []
    const off = subscribePresenceNow(() => seen.push(presenceNow()))
    const release = acquirePresenceClock()
    seen.length = 0

    jest.advanceTimersByTime(PRESENCE_TICK_MS)
    expect(seen).toEqual([Date.now()])

    jest.advanceTimersByTime(PRESENCE_TICK_MS * 3)
    expect(seen.length).toBe(4)
    expect(seen[3]).toBe(Date.now())

    release()
    off()
  })

  test('取消订阅后不再收到广播（组件卸载不留悬空回调）', () => {
    const seen: number[] = []
    const off = subscribePresenceNow(() => seen.push(1))
    const release = acquirePresenceClock()

    off()
    seen.length = 0
    jest.advanceTimersByTime(PRESENCE_TICK_MS * 2)
    expect(seen).toEqual([])

    release()
  })
})

describe('presence tick —— 停表', () => {
  test('释放后停表：不再广播，「现在」冻结在释放前', () => {
    const seen: number[] = []
    const off = subscribePresenceNow(() => seen.push(1))
    const release = acquirePresenceClock()

    release()
    seen.length = 0
    const frozen = presenceNow()
    jest.advanceTimersByTime(PRESENCE_TICK_MS * 5)

    expect(seen).toEqual([])
    expect(presenceNow()).toBe(frozen)
    expect(presenceNow()).toBeLessThan(Date.now())

    off()
  })

  test('停表后再占上：先对表，不沿用冻结的「现在」', () => {
    const first = acquirePresenceClock()
    first()
    jest.advanceTimersByTime(PRESENCE_TICK_MS * 2)
    const frozen = presenceNow()

    const seen: number[] = []
    const off = subscribePresenceNow(() => seen.push(presenceNow()))
    const again = acquirePresenceClock()

    expect(seen).toEqual([Date.now()])
    expect(presenceNow()).toBeGreaterThan(frozen)

    again()
    off()
  })

  test('两个持有者：放掉一个，表还在走；两个都放掉才停', () => {
    const seen: number[] = []
    const off = subscribePresenceNow(() => seen.push(1))
    const a = acquirePresenceClock()
    const b = acquirePresenceClock()

    a()
    seen.length = 0
    jest.advanceTimersByTime(PRESENCE_TICK_MS)
    expect(seen.length).toBe(1)

    b()
    seen.length = 0
    jest.advanceTimersByTime(PRESENCE_TICK_MS)
    expect(seen.length).toBe(0)

    off()
  })

  test('重复释放同一个持有权不扣别人的账（不会只剩一个页面却把表停掉）', () => {
    const seen: number[] = []
    const off = subscribePresenceNow(() => seen.push(1))
    const a = acquirePresenceClock()
    const b = acquirePresenceClock()

    a()
    a()
    seen.length = 0
    jest.advanceTimersByTime(PRESENCE_TICK_MS)
    expect(seen.length).toBe(1)

    b()
    seen.length = 0
    jest.advanceTimersByTime(PRESENCE_TICK_MS)
    expect(seen.length).toBe(0)

    off()
  })
})
