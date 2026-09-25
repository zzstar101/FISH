import { describe, expect, test } from 'bun:test'
import { createScanTicketRateLimiter } from './scan-rate-limit'

/**
 * 建票限流（#197）的窗口语义。
 *
 * e2e 只覆盖了「第 N+1 次被拒」，这里补两点：窗口**滑过之后要恢复**（不是永久封禁），
 * 以及不同 key（IP）各算一份——否则一个用户被封会连带封掉所有人，或者反过来形同虚设。
 */
describe('createScanTicketRateLimiter', () => {
  test('同一 key 超过上限被拒；窗口滑过后恢复', () => {
    let clock = 0
    const limiter = createScanTicketRateLimiter({
      limit: 3,
      windowMs: 1000,
      now: () => clock,
    })

    expect(limiter.take('ip-a')).toBe(true)
    expect(limiter.take('ip-a')).toBe(true)
    expect(limiter.take('ip-a')).toBe(true)
    expect(limiter.take('ip-a')).toBe(false)

    clock += 1000
    expect(limiter.take('ip-a')).toBe(true)
  })

  test('是滑动窗口而不是固定窗口：只算窗口内的命中', () => {
    let clock = 0
    const limiter = createScanTicketRateLimiter({
      limit: 2,
      windowMs: 1000,
      now: () => clock,
    })

    expect(limiter.take('ip-b')).toBe(true) // t=0
    clock += 600
    expect(limiter.take('ip-b')).toBe(true) // t=600
    expect(limiter.take('ip-b')).toBe(false) // 两条都还在窗口里

    clock += 401 // t=1001：t=0 那条已经滑出窗口
    expect(limiter.take('ip-b')).toBe(true)
  })

  test('不同 key 各算一份，互不影响', () => {
    const limiter = createScanTicketRateLimiter({ limit: 1, windowMs: 1000, now: () => 0 })

    expect(limiter.take('ip-c')).toBe(true)
    expect(limiter.take('ip-c')).toBe(false)
    // 另一个 IP 不该被前一个的额度牵连。
    expect(limiter.take('ip-d')).toBe(true)
  })
})
