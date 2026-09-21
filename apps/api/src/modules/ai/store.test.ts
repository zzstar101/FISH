import { expect, test } from 'bun:test'
import { createDb } from '@fish/db/client'
import { aiPolishRequests } from '@fish/db/schema/ai-polish-requests'
import { users } from '@fish/db/schema/users'
import { eq, inArray } from 'drizzle-orm'
import {
  AI_POLISH_DAILY_LIMIT,
  AI_POLISH_MIN_INTERVAL_SECONDS,
  createSqlAiPolishStore,
} from './store'

// 与 packages/db 的集成测试同一约定：没有 DATABASE_URL 就明确失败，而不是静默跳过。
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const db = createDb(databaseUrl)
const store = createSqlAiPolishStore(db)

const RESERVE_INPUT = { inputChars: 24, model: 'stub', promptVersion: 'test' }

let seq = 0
async function createUser(): Promise<string> {
  const rows = await db
    .insert(users)
    .values({
      studentNo: `ai-polish-${Date.now()}-${seq++}`,
      passwordHash: 'test-not-a-real-hash',
      nickname: '润色测试用户',
    })
    .returning({ id: users.id })
  const row = rows[0]
  if (!row) throw new Error('insert users 未返回行')
  return row.id
}

/** 每个用例自建、自清自己的数据（同 comments / listings store.test.ts 的约定）。 */
async function withUser(run: (userId: string) => Promise<void>): Promise<void> {
  const userId = await createUser()
  try {
    await run(userId)
  } finally {
    await db.delete(aiPolishRequests).where(eq(aiPolishRequests.userId, userId))
    await db.delete(users).where(inArray(users.id, [userId]))
  }
}

const reserve = (userId: string) => store.reserve({ userId, ...RESERVE_INPUT })

async function rowsOf(userId: string) {
  return db.select().from(aiPolishRequests).where(eq(aiPolishRequests.userId, userId))
}

test('首次请求放行，并写下 outcome 还是 NULL 的占位行', async () => {
  await withUser(async (userId) => {
    const result = await reserve(userId)
    expect(result.allowed).toBe(true)

    const rows = await rowsOf(userId)
    expect(rows).toHaveLength(1)
    // 占位行先落库：上游失败也扣配额由这一步保证（设计 §5.2）。
    expect(rows[0]?.outcome).toBeNull()
    expect(rows[0]?.inputChars).toBe(RESERVE_INPUT.inputChars)
    expect(rows[0]?.promptVersion).toBe(RESERVE_INPUT.promptVersion)
  })
})

test('占位行即使没回写（进程崩了）也计入间隔——`<> EMPTY` 会漏掉 NULL 行', async () => {
  await withUser(async (userId) => {
    await reserve(userId)
    const second = await reserve(userId)

    expect(second.allowed).toBe(false)
    if (second.allowed) throw new Error('unreachable')
    expect(second.retryAfterSeconds).toBeGreaterThan(0)
    expect(second.retryAfterSeconds).toBeLessThanOrEqual(AI_POLISH_MIN_INTERVAL_SECONDS)
    // 被拒请求不写行：否则会把 COUNT 撑大，形成"拒一次就少一次额度"的自我收紧。
    expect(await rowsOf(userId)).toHaveLength(1)
  })
})

test('回写 OK 后仍受间隔约束；回写 EMPTY 后立即可再请求', async () => {
  await withUser(async (userId) => {
    const first = await reserve(userId)
    if (!first.allowed) throw new Error('unreachable')
    await store.finish({
      requestId: first.requestId,
      outcome: 'OK',
      candidateCount: 3,
      filteredCount: 0,
      latencyMs: 1200,
      promptTokens: 100,
      completionTokens: 200,
    })

    const afterOk = await reserve(userId)
    expect(afterOk.allowed).toBe(false)

    // 第二条空结果：上游正常返回但候选全被过滤，对用户无损，不该让他白等一次（设计 §5.2）。
    const rows = await rowsOf(userId)
    const emptyRow = rows[0]
    if (!emptyRow) throw new Error('unreachable')
    await db
      .update(aiPolishRequests)
      .set({ outcome: 'EMPTY', candidateCount: 0, filteredCount: 2 })
      .where(eq(aiPolishRequests.id, emptyRow.id))

    const afterEmpty = await reserve(userId)
    expect(afterEmpty.allowed).toBe(true)
    // EMPTY 行照写（质量指标要用），只是不计入两条检查。
    expect(await rowsOf(userId)).toHaveLength(2)
  })
})

test('24h 内满 30 次后被拒，retryAfterSeconds 指向窗口滚动（不是 5s 间隔）', async () => {
  await withUser(async (userId) => {
    // 放在 10 分钟前：确保拒绝来自日额度而不是 5s 间隔。
    const createdAt = new Date(Date.now() - 10 * 60 * 1000)
    await db.insert(aiPolishRequests).values(
      Array.from({ length: AI_POLISH_DAILY_LIMIT }, () => ({
        userId,
        outcome: 'OK' as const,
        inputChars: 10,
        model: 'stub',
        promptVersion: 'test',
        createdAt,
      })),
    )

    const result = await reserve(userId)
    expect(result.allowed).toBe(false)
    if (result.allowed) throw new Error('unreachable')
    expect(result.retryAfterSeconds).toBeGreaterThan(3600)
    expect(await rowsOf(userId)).toHaveLength(AI_POLISH_DAILY_LIMIT)
  })
})

test('窗口外的旧行不占额度', async () => {
  await withUser(async (userId) => {
    await db.insert(aiPolishRequests).values(
      Array.from({ length: AI_POLISH_DAILY_LIMIT }, () => ({
        userId,
        outcome: 'OK' as const,
        inputChars: 10,
        model: 'stub',
        promptVersion: 'test',
        createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      })),
    )

    expect((await reserve(userId)).allowed).toBe(true)
  })
})

test('并发 10 个请求不放大计数：只放行 1 个、只写 1 行', async () => {
  await withUser(async (userId) => {
    const results = await Promise.all(Array.from({ length: 10 }, () => reserve(userId)))

    expect(results.filter((result) => result.allowed)).toHaveLength(1)
    expect(await rowsOf(userId)).toHaveLength(1)
  })
})

test('finish 把出口、候选数与 token 用量回写到占位行', async () => {
  await withUser(async (userId) => {
    const reserved = await reserve(userId)
    if (!reserved.allowed) throw new Error('unreachable')

    await store.finish({
      requestId: reserved.requestId,
      outcome: 'TOKEN_LOST',
      candidateCount: 2,
      filteredCount: 1,
      latencyMs: 1500,
      promptTokens: 300,
      completionTokens: 250,
    })

    const row = (await rowsOf(userId))[0]
    expect(row?.outcome).toBe('TOKEN_LOST')
    expect(row?.candidateCount).toBe(2)
    expect(row?.filteredCount).toBe(1)
    expect(row?.latencyMs).toBe(1500)
    expect(row?.promptTokens).toBe(300)
    expect(row?.completionTokens).toBe(250)
  })
})
