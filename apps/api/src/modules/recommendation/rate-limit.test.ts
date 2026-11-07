import { describe, expect, test } from 'bun:test'
import {
  RECOMMENDATION_FEED_IP_RATE_LIMIT,
  RECOMMENDATION_FEED_RATE_LIMIT,
} from '@fish/contracts/recommendation/observability'
import { RECOMMENDATION_RATE_LIMITED } from '@fish/contracts/recommendation/schema'
import {
  createTokenBucketLimiter,
  isIpRateLimitSubject,
  RECOMMENDATION_UNATTRIBUTED_SUBJECT,
  RecommendationRateLimitError,
  rateLimitSubjects,
} from './rate-limit'

/**
 * 令牌桶与主体键推导（#323 R6「令牌桶」一行）。
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

describe('按主体分档的令牌桶（#643 匿名 Feed 的 NAT 场景）', () => {
  /**
   * 直接引用契约常量：会话/用户桶 60 / 1·s⁻¹，出口 IP 桶 300 / 20·s⁻¹（#643）。
   * 不写死数字——契约数值被改坏（例如把 IP 桶收窄回会话档）时这条验收用例会变红。
   */
  const SESSION_SPEC = RECOMMENDATION_FEED_RATE_LIMIT
  const IP_SPEC = RECOMMENDATION_FEED_IP_RATE_LIMIT
  const NAT_IP = 'ip:203.0.113.7'

  function natLimiter(clock: () => number) {
    return createTokenBucketLimiter({
      ...SESSION_SPEC,
      maxSubjects: 1_000,
      clock,
      tierFor: (subject) => (isIpRateLimitSubject(subject) ? IP_SPEC : null),
    })
  }

  test('20 个匿名会话共用同一个 ip 主体，会话主体各自独立', () => {
    const sessions = Array.from({ length: 20 }, (_, index) => `session-${index}`)
    const subjects = sessions.map((sessionId) =>
      rateLimitSubjects({
        viewerId: null,
        anonymousSessionIds: [sessionId],
        clientIp: '203.0.113.7',
      }),
    )
    // 每个会话一条自己的 session 主体 + 同一个 ip 主体（NAT 出口）。
    expect(new Set(subjects.map((group) => group[0])).size).toBe(20)
    expect(new Set(subjects.map((group) => group[1])).size).toBe(1)
  })

  test('同一出口 IP 下 20 个独立匿名会话刷 30s：429 比例 < 1%', () => {
    const clock = fakeClock()
    const limiter = natLimiter(clock.now)
    const sessions = Array.from({ length: 20 }, (_, index) => `session:nat-${index}`)
    let total = 0
    let rejected = 0
    // 整栋楼 20 rps（20 个会话各 1 rps），持续 30 秒 = 600 次请求。
    for (let second = 0; second < 30; second += 1) {
      for (const session of sessions) {
        total += 1
        if (!limiter.takeAll([session, NAT_IP]).allowed) rejected += 1
      }
      clock.advance(1_000)
    }
    expect(total).toBe(600)
    expect(rejected / total).toBeLessThan(0.01)
  })

  test('单会话 10 rps 脚本仍被限流（防刷未被削弱）', () => {
    const clock = fakeClock()
    const limiter = natLimiter(clock.now)
    const total = 300 // 10 rps × 30s
    let allowed = 0
    for (let tick = 0; tick < total; tick += 1) {
      if (limiter.takeAll(['session:script', NAT_IP]).allowed) allowed += 1
      clock.advance(100)
    }
    // 会话桶容量 60 + 30 秒补 30 ≈ 90 次通过，其余 210 次必须被拒。
    expect(allowed).toBeLessThanOrEqual(95)
  })

  test('换会话脚本也逃不过 IP 桶：100 个新会话各打 10 次，只有 300 次能过', () => {
    const clock = fakeClock()
    const limiter = natLimiter(clock.now)
    let allowed = 0
    for (let session = 0; session < 100; session += 1) {
      for (let request = 0; request < 10; request += 1) {
        if (limiter.takeAll([`session:rotated-${session}`, NAT_IP]).allowed) allowed += 1
      }
    }
    // 每个会话的桶都是满的（10 < 60），能拦住的是 IP 桶的 300 个突发令牌。
    expect(allowed).toBe(300)
  })

  test('未命中 tierFor 的主体（ip:unattributed / session / user）继续用默认严格规格', () => {
    const clock = fakeClock()
    const limiter = createTokenBucketLimiter({
      capacity: 1,
      refillPerSecond: 1,
      maxSubjects: 10,
      clock: clock.now,
      tierFor: (subject) => (isIpRateLimitSubject(subject) ? IP_SPEC : null),
    })
    for (const subject of ['ip:unattributed', 'unattributed', 'session:s-1', 'user:u-1']) {
      expect(limiter.take(subject)).toEqual({ allowed: true })
      expect(limiter.take(subject)).toEqual({ allowed: false, retryAfterSeconds: 1 })
    }
    // 同进程里的可归因 IP 主体仍是 IP 档：1 个令牌之后要等 0.05s（向上取整 1s）。
    expect(limiter.take(NAT_IP)).toEqual({ allowed: true })
  })

  test('isIpRateLimitSubject 只认可归因的 ip: 主体', () => {
    expect(isIpRateLimitSubject(NAT_IP)).toBe(true)
    expect(isIpRateLimitSubject('ip:10.0.0.1')).toBe(true)
    expect(isIpRateLimitSubject('ip:unattributed')).toBe(false)
    expect(isIpRateLimitSubject('unattributed')).toBe(false)
    expect(isIpRateLimitSubject('session:s-1')).toBe(false)
    expect(isIpRateLimitSubject('user:u-1')).toBe(false)
  })
})

describe('rateLimitSubjects 主体键', () => {
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
