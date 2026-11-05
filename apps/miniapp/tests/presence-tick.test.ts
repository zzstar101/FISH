import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import {
  acquirePresenceClock,
  createPresenceClockHolder,
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
 * 时钟是模块单例，所以每条用例自己占、自己放：`beforeEach` 只把定时器换成假的，
 * 不替用例收尾 —— 漏放会让下一条从「已经有人在前台」的状态开始（这里宁可每条用例
 * 自己写干净释放，也不要一个隐式兜底把泄漏掩盖掉）。
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

describe('presence tick —— 页面侧的持有权守卫', () => {
  test('start 幂等：重复占上只有一份持有权，放掉一次就停表', () => {
    const seen: number[] = []
    const off = subscribePresenceNow(() => seen.push(1))
    const holder = createPresenceClockHolder()

    holder.start()
    holder.start()
    holder.start()
    expect(holder.held()).toBe(true)

    holder.stop()
    seen.length = 0
    jest.advanceTimersByTime(PRESENCE_TICK_MS)
    // 泄漏成三份持有权的话这里会是 1（表还在走）
    expect(seen).toEqual([])
    expect(holder.held()).toBe(false)

    off()
  })

  test('stop 幂等：没占着时放、或放两次，都不扣别人的账', () => {
    const seen: number[] = []
    const off = subscribePresenceNow(() => seen.push(1))
    const mine = createPresenceClockHolder()
    const other = acquirePresenceClock()

    mine.stop()
    mine.start()
    mine.stop()
    mine.stop()

    seen.length = 0
    jest.advanceTimersByTime(PRESENCE_TICK_MS)
    expect(seen.length).toBe(1)

    other()
    off()
  })

  test('didShow / didHide 与挂载 effect 重叠（start,start,stop 或 start,stop,start）不会漏表也不会多扣', () => {
    const seen: number[] = []
    const off = subscribePresenceNow(() => seen.push(1))
    const holder = createPresenceClockHolder()

    holder.start() // 挂载 effect
    holder.start() // 同一帧的 didShow
    holder.stop() // didHide
    seen.length = 0
    jest.advanceTimersByTime(PRESENCE_TICK_MS)
    expect(seen).toEqual([])

    holder.start() // 回到前台
    seen.length = 0
    jest.advanceTimersByTime(PRESENCE_TICK_MS)
    expect(seen.length).toBe(1)

    holder.stop()
    off()
  })
})

describe('presence tick —— 广播里抛错不拖死表', () => {
  test('一个订阅者抛错不连累其他人，表照样起来', () => {
    const ok: number[] = []
    const offBad = subscribePresenceNow(() => {
      throw new Error('订阅者自己炸了')
    })
    const offGood = subscribePresenceNow(() => ok.push(1))
    const errors: unknown[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => {
      errors.push(args)
    }

    let release: (() => void) | null = null
    try {
      expect(() => {
        release = acquirePresenceClock()
      }).not.toThrow()

      // 好订阅者在同一跳里照常收到广播（不是被前面那个抛错的人截断）
      expect(ok.length).toBe(1)
      expect(errors.length).toBe(1)

      // 表已经在走：下一跳继续
      ok.length = 0
      jest.advanceTimersByTime(PRESENCE_TICK_MS)
      expect(ok.length).toBe(1)
    } finally {
      console.error = originalError
      release?.()
      offBad()
      offGood()
    }
  })
})
