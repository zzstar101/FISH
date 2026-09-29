import { afterAll, expect, test } from 'bun:test'
import { createDb } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { visualSearchAttempts } from '@fish/db/schema/visual-search-attempts'
import { and, eq, like, sql } from 'drizzle-orm'
import {
  createVisualSearchRateLimiter,
  pruneExpiredVisualSearchAttempts,
  VISUAL_SEARCH_MAX_ATTEMPTS,
  VISUAL_SEARCH_WINDOW_SECONDS,
  type VisualSearchAttemptSubject,
  VisualSearchRateLimitError,
  type VisualSearchRateLimiter,
} from './rate-limit'

// 与 packages/db 的集成测试同一约定：缺 DATABASE_URL 就明确失败，而不是静默跳过。
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const db = createDb(databaseUrl)

// 每次都换前缀，afterAll 只删自己造的行，不碰其它用例/开发数据。
const TEST_PREFIX = `rate-limit-test-${Date.now()}`
let seq = 0

/** 主体键带前缀，方便按前缀精确回收。 */
function subjectKeyOf(label: string): string {
  return `${TEST_PREFIX}-${seq++}-${label}`
}

function userSubject(key: string): VisualSearchAttemptSubject {
  return { subjectType: 'user', subjectKey: key }
}

afterAll(async () => {
  await db
    .delete(visualSearchAttempts)
    .where(like(visualSearchAttempts.subjectKey, `${TEST_PREFIX}%`))
  await db.$client.close()
})

async function attemptCount(
  subjectType: VisualSearchAttemptSubject['subjectType'],
  subjectKey: string,
): Promise<number> {
  const rows = await db
    .select({ id: visualSearchAttempts.id })
    .from(visualSearchAttempts)
    .where(
      and(
        eq(visualSearchAttempts.subjectType, subjectType),
        eq(visualSearchAttempts.subjectKey, subjectKey),
      ),
    )
  return rows.length
}

async function expectRateLimitError(work: Promise<void>): Promise<VisualSearchRateLimitError> {
  const caught = await work.then(
    () => null,
    (error: unknown) => error,
  )
  expect(caught).toBeInstanceOf(VisualSearchRateLimitError)
  // 收窄类型供后续断言使用；不用 as/any。
  if (!(caught instanceof VisualSearchRateLimitError)) throw new Error('未抛出限流错误')
  return caught
}

/** 反复 consume 直到被拒；从非零起点也能续满额度，同时兜底断言上限一定生效。 */
async function exhaust(
  limiter: VisualSearchRateLimiter,
  subject: VisualSearchAttemptSubject,
): Promise<void> {
  for (let i = 0; i <= VISUAL_SEARCH_MAX_ATTEMPTS; i++) {
    try {
      await limiter.consume([subject])
    } catch (error) {
      if (error instanceof VisualSearchRateLimitError) return
      throw error
    }
  }
  throw new Error('consume 在达到上限后仍未拒绝')
}

test('用满配额前每次都放行，第 cap+1 次抛 VisualSearchRateLimitError', async () => {
  const limiter = createVisualSearchRateLimiter(db)
  const key = subjectKeyOf('cap')
  for (let i = 0; i < VISUAL_SEARCH_MAX_ATTEMPTS; i++) {
    await limiter.consume([userSubject(key)])
  }
  await expectRateLimitError(limiter.consume([userSubject(key)]))
})

test('retryAfterSeconds 是 [1, 窗口秒数] 内的整数（滚动窗口从最老一条算起）', async () => {
  const limiter = createVisualSearchRateLimiter(db)
  const key = subjectKeyOf('retry-after')
  await exhaust(limiter, userSubject(key))
  const error = await expectRateLimitError(limiter.consume([userSubject(key)]))
  // 只断言区间：具体秒数取决于最新一条的写入时刻，断言等值会变成时钟竞态。
  expect(Number.isInteger(error.retryAfterSeconds)).toBe(true)
  expect(error.retryAfterSeconds).toBeGreaterThanOrEqual(1)
  expect(error.retryAfterSeconds).toBeLessThanOrEqual(VISUAL_SEARCH_WINDOW_SECONDS)
})

test('每次成功 consume 精确插入一行/主体', async () => {
  const limiter = createVisualSearchRateLimiter(db)
  const key = subjectKeyOf('one-row')
  expect(await attemptCount('user', key)).toBe(0)
  await limiter.consume([userSubject(key)])
  expect(await attemptCount('user', key)).toBe(1)
  await limiter.consume([userSubject(key)])
  expect(await attemptCount('user', key)).toBe(2)
})

test('不同 subjectKey 各自计数，A 用满不挡 B', async () => {
  const limiter = createVisualSearchRateLimiter(db)
  const exhausted = subjectKeyOf('independent-a')
  const fresh = subjectKeyOf('independent-b')
  await exhaust(limiter, userSubject(exhausted))
  await expectRateLimitError(limiter.consume([userSubject(exhausted)]))
  await limiter.consume([userSubject(fresh)])
  expect(await attemptCount('user', fresh)).toBe(1)
})

test('匿名多主体必须同时未超限：ip 超限时 session 未超限也拒绝，且不写 session 行', async () => {
  const limiter = createVisualSearchRateLimiter(db)
  const sessionKey = subjectKeyOf('anon-session')
  const ipKey = subjectKeyOf('anon-ip')
  const session: VisualSearchAttemptSubject = { subjectType: 'session', subjectKey: sessionKey }
  const ip: VisualSearchAttemptSubject = { subjectType: 'ip', subjectKey: ipKey }

  // 两条都未超限时放行，且两个主体各记一行。
  await limiter.consume([session, ip])
  expect(await attemptCount('session', sessionKey)).toBe(1)
  expect(await attemptCount('ip', ipKey)).toBe(1)

  await exhaust(limiter, ip)
  const error = await expectRateLimitError(limiter.consume([session, ip]))
  expect(error.retryAfterSeconds).toBeGreaterThanOrEqual(1)
  // 拒绝发生在插入之前：未超限的 session 不能被算掉一次额度。
  expect(await attemptCount('session', sessionKey)).toBe(1)
})

test('窗口外的旧行不计入配额：原始行数已达上限，下一次 consume 仍放行', async () => {
  const limiter = createVisualSearchRateLimiter(db)
  const key = subjectKeyOf('stale-ignored')
  const staleAt = new Date(Date.now() - (VISUAL_SEARCH_WINDOW_SECONDS + 5) * 1000)
  await db.insert(visualSearchAttempts).values([
    // cap-1 条窗口内 + 1 条窗口外：按行数看已到上限，按窗口算还差一个名额。
    ...Array.from({ length: VISUAL_SEARCH_MAX_ATTEMPTS - 1 }, () => ({
      id: newId(),
      subjectType: 'user',
      subjectKey: key,
      createdAt: new Date(),
    })),
    { id: newId(), subjectType: 'user', subjectKey: key, createdAt: staleAt },
  ])
  expect(await attemptCount('user', key)).toBe(VISUAL_SEARCH_MAX_ATTEMPTS)

  await limiter.consume([userSubject(key)])

  // 旧行已被配额事务顺手清掉，只剩窗口内的一批。
  expect(await attemptCount('user', key)).toBe(VISUAL_SEARCH_MAX_ATTEMPTS)
})

test('pruneExpiredVisualSearchAttempts 只删窗口外的行', async () => {
  const freshId = newId()
  const staleId = newId()
  const key = subjectKeyOf('prune')
  await db.insert(visualSearchAttempts).values([
    { id: freshId, subjectType: 'user', subjectKey: key, createdAt: new Date() },
    {
      id: staleId,
      subjectType: 'user',
      subjectKey: key,
      // 造得足够老，保证落在 prune 的「ORDER BY created_at LIMIT 500」窗口里。
      createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    },
  ])

  await pruneExpiredVisualSearchAttempts(db)

  const survivors = await db
    .select({ id: visualSearchAttempts.id })
    .from(visualSearchAttempts)
    .where(eq(visualSearchAttempts.subjectKey, key))
  expect(survivors.map((row) => row.id)).toEqual([freshId])
})

test('相同 subjectKey 的不同 subjectType 是两个独立桶', async () => {
  const limiter = createVisualSearchRateLimiter(db)
  const key = subjectKeyOf('type-bucket')
  await exhaust(limiter, userSubject(key))
  await expectRateLimitError(limiter.consume([userSubject(key)]))
  // user:key 用满不影响 session:key（同一个字符串）。
  await limiter.consume([{ subjectType: 'session', subjectKey: key }])
  expect(await attemptCount('session', key)).toBe(1)
})

test('retryAfterSeconds 取多主体里最晚释放的那个：短的那个会让客户端重试必然再被拒', async () => {
  const limiter = createVisualSearchRateLimiter(db)
  const ipKey = subjectKeyOf('worst-ip')
  const sessionKey = subjectKeyOf('worst-session')
  // ip 桶：cap 条都在 50s 前写入 ⇒ 再等约 10s 就释放；session 桶：cap 条都在 5s 前写入 ⇒ 还要等约 55s。
  await db.insert(visualSearchAttempts).values([
    ...Array.from({ length: VISUAL_SEARCH_MAX_ATTEMPTS }, () => ({
      id: newId(),
      subjectType: 'ip' as const,
      subjectKey: ipKey,
      createdAt: new Date(Date.now() - 50_000),
    })),
    ...Array.from({ length: VISUAL_SEARCH_MAX_ATTEMPTS }, () => ({
      id: newId(),
      subjectType: 'session' as const,
      subjectKey: sessionKey,
      createdAt: new Date(Date.now() - 5_000),
    })),
  ])

  const error = await expectRateLimitError(
    limiter.consume([
      { subjectType: 'ip', subjectKey: ipKey },
      { subjectType: 'session', subjectKey: sessionKey },
    ]),
  )

  // 取最短（ip 的 ~10s）会让客户端重试必然再被拒；必须是两者里最晚释放的（~55s）。
  expect(error.retryAfterSeconds).toBeGreaterThanOrEqual(45)
  expect(error.retryAfterSeconds).toBeLessThanOrEqual(VISUAL_SEARCH_WINDOW_SECONDS)
})

test('没有主体时 consume 直接放行：不抛错、不写行（不该发生的输入不能变成 5xx）', async () => {
  const limiter = createVisualSearchRateLimiter(db)
  await limiter.consume([])
})

test('pruneExpiredVisualSearchAttempts 每次最多删 500 行：一次调用清不空超过上限的陈旧数据', async () => {
  const key = subjectKeyOf('prune-bound')
  const staleAt = new Date(Date.now() - (VISUAL_SEARCH_WINDOW_SECONDS + 30) * 1000)
  // 一条 INSERT ... SELECT generate_series 造 520 行窗口外数据，避免 520 次往返。
  await db.execute(sql`INSERT INTO visual_search_attempts (id, subject_type, subject_key, created_at)
    SELECT gen_random_uuid(), 'user', ${key}, ${staleAt} FROM generate_series(1, 520)`)
  expect(await attemptCount('user', key)).toBe(520)

  await pruneExpiredVisualSearchAttempts(db)

  // 有界：一次最多 500 行，所以 520 行不可能被一次清空（无界时这里会是 0）。
  expect(await attemptCount('user', key)).toBeGreaterThanOrEqual(20)
})

test('全局清理受进程内门控：同一窗口内第二次 consume 不会再扫全表', async () => {
  const limiter = createVisualSearchRateLimiter(db)
  // 先 consume 一次：无论此前门控是否开启过，这一步之后「上次清理时刻」一定落在当前窗口内。
  await limiter.consume([userSubject(subjectKeyOf('prune-gate-warmup'))])

  const witnessKey = subjectKeyOf('prune-gate-witness')
  await db.insert(visualSearchAttempts).values({
    id: newId(),
    subjectType: 'user',
    subjectKey: witnessKey,
    createdAt: new Date(Date.now() - (VISUAL_SEARCH_WINDOW_SECONDS + 30) * 1000),
  })

  await limiter.consume([userSubject(subjectKeyOf('prune-gate-second'))])

  // 门控生效 ⇒ 第二次 consume 没做全局清理，窗口外的见证行还在（每次清理时这里会是 0）。
  expect(await attemptCount('user', witnessKey)).toBe(1)
})

test('并发 consume 同一主体由 advisory lock 串行化：上限不会被一起挤过', async () => {
  const limiter = createVisualSearchRateLimiter(db)
  const key = subjectKeyOf('concurrent')
  // 垫到 cap-1：并发窗口里只剩一个名额。
  await db.insert(visualSearchAttempts).values(
    Array.from({ length: VISUAL_SEARCH_MAX_ATTEMPTS - 1 }, () => ({
      id: newId(),
      subjectType: 'user' as const,
      subjectKey: key,
      createdAt: new Date(),
    })),
  )

  const outcomes = await Promise.allSettled([
    limiter.consume([userSubject(key)]),
    limiter.consume([userSubject(key)]),
    limiter.consume([userSubject(key)]),
    limiter.consume([userSubject(key)]),
  ])

  // 无锁的 count-then-insert 会让多个请求同时读到 cap-1 并各自插入（实测 21 行 > 上限 20）。
  expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
  expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(3)
  expect(await attemptCount('user', key)).toBe(VISUAL_SEARCH_MAX_ATTEMPTS)
})
