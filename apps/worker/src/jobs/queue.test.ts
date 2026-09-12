import { afterAll, expect, test } from 'bun:test'
import { createDb } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import type { JobType } from '@fish/db/schema/jobs'
import { jobs } from '@fish/db/schema/jobs'
import { sql } from 'drizzle-orm'
import { createJobQueue, DEFAULT_MAX_ATTEMPTS, parseJobPayload } from './queue'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const db = createDb(databaseUrl)

// 每个测试文件都会建自己的连接池。不关掉的话，`bun test` 并行跑全量测试会把本地 PG 的
// max_connections（默认 100）顶爆，表现为 53300 `too many clients already`——那时失败的是
// 恰好抢不到连接的那个文件，看上去像随机的 flaky。
afterAll(async () => {
  await db.$client.close()
})

/**
 * 队列测试的真实回归点：**payload 从 `db.execute` 出来是文本**，
 * 没解码时 handler 会拿到字符串（线上冒烟时这里直接炸过）。
 */
test('parseJobPayload 解码 jsonb 文本，并兼容双重编码的历史行', () => {
  expect(parseJobPayload({ listingId: 'x' })).toEqual({ listingId: 'x' })
  expect(parseJobPayload('{"listingId":"x"}')).toEqual({ listingId: 'x' })
  // 「JSON 字符串套 JSON」：`packages/db/src/json.ts` 描述过的坏行，parse 一次即还原。
  expect(parseJobPayload('"{\\"listingId\\":\\"x\\"}"')).toEqual({ listingId: 'x' })
  // 非 JSON 文本原样返回 → 交给 schema 判成坏 payload。
  expect(parseJobPayload('not json')).toBe('not json')
})

/**
 * 每条测试自己造 job，`run_at` 设到过去，保证它排在（本地库里可能存在的）历史 job 之前被领取。
 *
 * 失败重试会由 `settle()` 把 `run_at` 推回 `now()`，于是下一轮可能先领到历史 job——
 * 需要连续多轮时用 `rewind()` 把自己的 job 重新拉回队首。
 */
async function rewind(jobId: string): Promise<void> {
  await db.execute(sql`update jobs set run_at = '2000-01-01' where id = ${jobId}`)
}

async function withJob(
  run: (queue: ReturnType<typeof createJobQueue>, jobId: string) => Promise<void>,
  options: { payload?: Record<string, unknown>; attempts?: number } = {},
): Promise<void> {
  const jobId = newId()
  await db.insert(jobs).values({
    id: jobId,
    type: 'MATCH_LISTING',
    payload: options.payload ?? { listingId: newId() },
    attempts: options.attempts ?? 0,
    runAt: new Date('2000-01-01T00:00:00Z'),
  })

  const queue = createJobQueue(db, {
    handlers: {
      MATCH_LISTING: async (payload) => {
        // 断言 handler 拿到的是**已解码的对象**。
        if (typeof payload !== 'object' || payload === null) {
          throw new Error(`payload 未解码：${typeof payload}`)
        }
        return { ok: true, received: payload }
      },
    },
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
  })

  try {
    await run(queue, jobId)
  } finally {
    await db.delete(jobs).where(sql`${jobs.id} = ${jobId}`)
  }
}

async function jobRow(id: string) {
  const rows = await db
    .select({ status: jobs.status, attempts: jobs.attempts, lastError: jobs.lastError })
    .from(jobs)
    .where(sql`${jobs.id} = ${id}`)
  return rows[0] ?? null
}

test('runOnce 领取并执行 job，handler 拿到解码后的 payload，job 置 DONE', async () => {
  await withJob(async (queue, jobId) => {
    const outcome = await queue.runOnce()

    expect(outcome).toMatchObject({ id: jobId, type: 'MATCH_LISTING', status: 'DONE' })
    // 真实运行时冒烟的回归点：handler 拿到的 payload 必须是对象（不是 jsonb 文本）。
    expect(outcome?.result).toEqual({
      ok: true,
      received: expect.objectContaining({ listingId: expect.any(String) }),
    })
    expect(await jobRow(jobId)).toMatchObject({ status: 'DONE', attempts: 1 })
  })
})

test('失败且未达上限时回到 PENDING，达到上限后 FAILED', async () => {
  const failing = createJobQueue(db, {
    handlers: {
      MATCH_LISTING: async () => {
        throw new Error('boom')
      },
    },
    maxAttempts: 3,
  })

  await withJob(async (_queue, jobId) => {
    // 前两次失败 → 可重试；第三次（attempts 达上限）→ FAILED。
    expect((await failing.runOnce())?.status).toBe('PENDING')
    expect(await jobRow(jobId)).toMatchObject({ status: 'PENDING', attempts: 1 })

    await rewind(jobId)
    expect((await failing.runOnce())?.status).toBe('PENDING')
    expect(await jobRow(jobId)).toMatchObject({ status: 'PENDING', attempts: 2 })

    await rewind(jobId)
    expect((await failing.runOnce())?.status).toBe('FAILED')
    expect(await jobRow(jobId)).toMatchObject({
      status: 'FAILED',
      attempts: 3,
      lastError: 'Error: boom',
    })
  })
})

test('坏 payload（fatal）不重试，直接 FAILED', async () => {
  const queue = createJobQueue(db, {
    handlers: {
      MATCH_LISTING: async () => {
        throw new Error('bad payload')
      },
    },
    isFatalError: () => true,
  })

  await withJob(
    async () => {
      const outcome = await queue.runOnce()
      expect(outcome?.status).toBe('FAILED')
    },
    { attempts: 0 },
  )
})

test('未知 job 类型直接 FAILED', async () => {
  const jobId = newId()
  await db.insert(jobs).values({
    id: jobId,
    // `jobs.type` 是裸 text，TS 联合只是收窄：这里造一行真·未知类型的数据。
    type: 'UNKNOWN_JOB' as JobType,
    payload: { anything: true },
    runAt: new Date('2000-01-01T00:00:00Z'),
  })

  try {
    const queue = createJobQueue(db, { handlers: {} })
    const outcome = await queue.runOnce()
    expect(outcome).toMatchObject({ id: jobId, status: 'FAILED' })
    expect(await jobRow(jobId)).toMatchObject({ status: 'FAILED' })
  } finally {
    await db.delete(jobs).where(sql`${jobs.id} = ${jobId}`)
  }
})
