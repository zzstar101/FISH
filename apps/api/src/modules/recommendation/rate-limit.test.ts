import { describe, expect, test } from 'bun:test'
import { RECOMMENDATION_RATE_LIMITED } from '@fish/contracts/recommendation/schema'
import {
  createTokenBucketLimiter,
  RECOMMENDATION_UNATTRIBUTED_SUBJECT,
  RecommendationRateLimitError,
  rateLimitSubjects,
} from './rate-limit'

/**
 * 令牌桶与主体键推导（#323 R6 §10.1「令牌桶」一行）。
 *
 * 时钟是注入的假时钟：真时钟下这些用例要靠 `Bun.sleep` 等待，既慢又不稳
 * （容量耗尽与补充的断言必须精确到"第几秒"）。
 */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let current = start
  return { now: () => current, advance: (ms: number) => (current += ms) }
}

describe('createTokenBucketLimiter（R6 限流）', () => {
  test('容量耗尽后拒绝，retryAfterSeconds 随补充递减', () => {
    const clock = fakeClock()
    const limiter = createTokenBucketLimiter({
      capacity: 3,
      refillPerSecond: 1,
      maxSubjects: 10,
      clock: clock.now,
    })

    expect(limiter.take('ip:1.1.1.1')).toEqual({ allowed: true })
    expect(limiter.take('ip:1.1.1.1')).toEqual({ allowed: true })
    expect(limiter.take('ip:1.1.1.1')).toEqual({ allowed: true })
    // 第 4 次：0 个令牌，补满 1 个需要 1 秒。
    expect(limiter.take('ip:1.1.1.1')).toEqual({ allowed: false, retryAfterSeconds: 1 })

    // 0.4 秒后仍不够，向上取整还是 1 秒（不是 0：客户端会立刻重试）。
    clock.advance(400)
    expect(limiter.take('ip:1.1.1.1')).toEqual({ allowed: false, retryAfterSeconds: 1 })

    // 再过 0.6 秒（累计 1 秒）补回 1 个令牌。
    clock.advance(600)
    expect(limiter.take('ip:1.1.1.1')).toEqual({ allowed: true })
  })

  test('补充不会超过容量；两个主体互不干扰', () => {
    const clock = fakeClock()
    const limiter = createTokenBucketLimiter({
      capacity: 2,
      refillPerSecond: 10,
      maxSubjects: 10,
      clock: clock.now,
    })

    expect(limiter.take('a')).toEqual({ allowed: true })
    expect(limiter.take('a')).toEqual({ allowed: true })
    expect(limiter.take('a')).toEqual({ allowed: false, retryAfterSeconds: 1 })

    // 长时间空闲后也只补到容量 2（不是无限攒）。
    clock.advance(60_000)
    expect(limiter.take('a')).toEqual({ allowed: true })
    expect(limiter.take('a')).toEqual({ allowed: true })
    expect(limiter.take('a')).toEqual({ allowed: false, retryAfterSeconds: 1 })

    // 另一个主体有自己的桶，不受影响。
    expect(limiter.take('b')).toEqual({ allowed: true })
  })

  test('多主体取最严：任一不过则整体拒绝，且**不**扣另一个主体的额度', () => {
    const clock = fakeClock()
    const limiter = createTokenBucketLimiter({
      capacity: 2,
      refillPerSecond: 1,
      maxSubjects: 10,
      clock: clock.now,
    })

    // 会话与 IP 各扣 1（容量 2 → 各剩 1）。
    expect(limiter.takeAll(['session:s1', 'ip:1.1.1.1'])).toEqual({ allowed: true })
    // 把 IP 的额度用掉：剩 1 → 0。
    expect(limiter.take('ip:1.1.1.1')).toEqual({ allowed: true })

    // 整体被拒（IP 没额度了），此时会话的 1 个令牌必须还在。
    expect(limiter.takeAll(['session:s1', 'ip:1.1.1.1'])).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    })
    expect(limiter.take('session:s1')).toEqual({ allowed: true })
  })

  test('多主体被拒时取最大等待秒数', () => {
    const clock = fakeClock()
    const limiter = createTokenBucketLimiter({
      capacity: 2,
      refillPerSecond: 0.25,
      maxSubjects: 10,
      clock: clock.now,
    })

    // t=0：IP 的桶清空（updatedAt=0）。
    limiter.take('ip:1.1.1.1')
    limiter.take('ip:1.1.1.1')

    // t=1000：会话的桶清空（updatedAt=1000，比 IP 晚 ⇒ 补得少 ⇒ 等得久）。
    clock.advance(1_000)
    limiter.take('session:s1')
    limiter.take('session:s1')

    // t=2000：IP 补到 0.5（补满还需 2 秒），会话补到 0.25（还需 3 秒）⇒ 取最大 3。
    clock.advance(1_000)
    expect(limiter.takeAll(['session:s1', 'ip:1.1.1.1'])).toEqual({
      allowed: false,
      retryAfterSeconds: 3,
    })
  })

  test('同一主体在一次 takeAll 里重复出现只算一份', () => {
    const clock = fakeClock()
    const limiter = createTokenBucketLimiter({
      capacity: 2,
      refillPerSecond: 1,
      maxSubjects: 10,
      clock: clock.now,
    })

    expect(limiter.takeAll(['session:s1', 'session:s1', 'session:s1'])).toEqual({ allowed: true })
    // 只扣了 1 个令牌（容量 2 → 剩 1）。
    expect(limiter.take('session:s1')).toEqual({ allowed: true })
  })

  test('空主体列表直接放行（没有任何可限的身份）', () => {
    const limiter = createTokenBucketLimiter({
      capacity: 1,
      refillPerSecond: 1,
      maxSubjects: 10,
    })
    expect(limiter.takeAll([])).toEqual({ allowed: true })
  })

  test('桶数超过上限时淘汰最久未用的主体，被淘汰者重新获得满额度', () => {
    const limiter = createTokenBucketLimiter({
      capacity: 1,
      refillPerSecond: 0.001,
      maxSubjects: 2,
    })

    expect(limiter.take('a')).toEqual({ allowed: true })
    expect(limiter.take('b')).toEqual({ allowed: true })
    expect(limiter.size()).toBe(2)

    // 插入 c：最久未用的 a 被淘汰。
    expect(limiter.take('c')).toEqual({ allowed: true })
    expect(limiter.size()).toBe(2)
    expect(limiter.take('c')).toEqual({ allowed: false, retryAfterSeconds: 1000 })

    // a 是"新主体"了（旧桶已被淘汰），因此又有额度——这是 LRU 的已知代价：
    // 用内存上限换"不精确的配额"，比让 Map 无限增长安全（见常量注释）。
    expect(limiter.take('a')).toEqual({ allowed: true })
    expect(limiter.size()).toBe(2)
  })

  test('非法参数在构造时就失败（不给带病运行的桶）', () => {
    expect(() =>
      createTokenBucketLimiter({ capacity: 0, refillPerSecond: 1, maxSubjects: 10 }),
    ).toThrow('令牌桶容量必须是正整数')
    expect(() =>
      createTokenBucketLimiter({ capacity: 1.5, refillPerSecond: 1, maxSubjects: 10 }),
    ).toThrow('令牌桶容量必须是正整数')
    expect(() =>
      createTokenBucketLimiter({ capacity: 1, refillPerSecond: 0, maxSubjects: 10 }),
    ).toThrow('令牌桶补充速率必须是正数')
    expect(() =>
      createTokenBucketLimiter({ capacity: 1, refillPerSecond: 1, maxSubjects: 0 }),
    ).toThrow('令牌桶主体上限必须是正整数')
  })
})

describe('rateLimitSubjects（§2.3 主体键）', () => {
  test('登录用户只有 user 桶（不叠 IP）', () => {
    expect(rateLimitSubjects({ viewerId: 'u-1', clientIp: '1.1.1.1' })).toEqual(['user:u-1'])
    expect(
      rateLimitSubjects({ viewerId: 'u-1', anonymousSessionIds: ['s-1'], clientIp: '1.1.1.1' }),
    ).toEqual(['user:u-1'])
  })

  test('匿名同时过会话与可信 IP 两条桶，会话转小写去重', () => {
    expect(
      rateLimitSubjects({
        viewerId: null,
        anonymousSessionIds: ['0B6E5E1E-0000-4000-8000-000000000001'],
        clientIp: '1.1.1.1',
      }),
    ).toEqual(['session:0b6e5e1e-0000-4000-8000-000000000001', 'ip:1.1.1.1'])

    expect(
      rateLimitSubjects({
        viewerId: null,
        anonymousSessionIds: ['S-1', 's-1', null, undefined],
        clientIp: '1.1.1.1',
      }),
    ).toEqual(['session:s-1', 'ip:1.1.1.1'])
  })

  test('IP 无法归因时落到共享 unattributed 桶（fail-closed）', () => {
    expect(
      rateLimitSubjects({ viewerId: null, anonymousSessionIds: ['s-1'], clientIp: null }),
    ).toEqual(['session:s-1', `ip:${RECOMMENDATION_UNATTRIBUTED_SUBJECT}`])
    // 不是合法 IP（客户端伪造的转发头值）同样落到兜底桶，而不是变成一个新的"身份"。
    expect(
      rateLimitSubjects({ viewerId: null, anonymousSessionIds: [], clientIp: 'not-an-ip' }),
    ).toEqual([`ip:${RECOMMENDATION_UNATTRIBUTED_SUBJECT}`])
    expect(
      rateLimitSubjects({ viewerId: null, anonymousSessionIds: [], clientIp: ' 1.1.1.1' }),
    ).toEqual([`ip:${RECOMMENDATION_UNATTRIBUTED_SUBJECT}`])
  })

  test('IPv4-mapped IPv6 归一成 IPv4（同一出口不会占两个桶）', () => {
    expect(
      rateLimitSubjects({ viewerId: null, anonymousSessionIds: [], clientIp: '::ffff:1.1.1.1' }),
    ).toEqual(['ip:1.1.1.1'])
  })

  test('既没有会话也没有可归因 IP 时只剩共享桶（最少也有一条额度）', () => {
    expect(rateLimitSubjects({ viewerId: null, clientIp: null })).toEqual([
      `ip:${RECOMMENDATION_UNATTRIBUTED_SUBJECT}`,
    ])
  })
})

describe('RecommendationRateLimitError', () => {
  test('状态码、错误码与 retryAfterSeconds 走契约', () => {
    const error = new RecommendationRateLimitError(2.4)
    expect(error.status).toBe(429)
    expect(error.code).toBe(RECOMMENDATION_RATE_LIMITED)
    expect(error.code).toBe('RECOMMENDATION_RATE_LIMITED')
    expect(error.retryAfterSeconds).toBe(3)
    expect(error.message).toBe('埋点写入过于频繁')
    expect(error.name).toBe('RecommendationRateLimitError')
  })

  test('retryAfterSeconds 至少 1（契约要求正整数）', () => {
    expect(new RecommendationRateLimitError(0.2).retryAfterSeconds).toBe(1)
    expect(new RecommendationRateLimitError(0).retryAfterSeconds).toBe(1)
  })
})
