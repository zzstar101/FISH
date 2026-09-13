import { afterAll, expect, test } from 'bun:test'
import { createDb, type Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import type { JobType } from '@fish/db/schema/jobs'
import { jobs } from '@fish/db/schema/jobs'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createJobQueue, DEFAULT_MAX_ATTEMPTS, parseJobPayload, STALE_CLAIM_ERROR } from './queue'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

// 必须用 Bun.fileURLToPath：URL.pathname 在 Windows 上是 /C:/... 形式，migrator 读不到。
const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../../packages/db/src/migrations', import.meta.url),
)

/**
 * 本项目文件共享开发库（本文件的 `runOnce` 用例都是），但**回收用例用独立 scratch 库**：
 * `recoverStaleClaims()` 是**全表** UPDATE（无 id 过滤），跑在开发库上会把别人正在跑的 `RUNNING`
 * 行翻回 `PENDING`，让同一个 job 被两个进程各执行一次。与 `seed.test.ts` 用 scratch 库的理由相同。
 */
const scratchDatabase = `fish_queue_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const db = createDb(databaseUrl)
let scratch: Db | null = null

async function scratchDb(): Promise<Db> {
  if (!scratch) {
    // 上一次被硬杀（Ctrl-C / 超时）留下的同名库会让 `create database` 报 42P04，
    // 而那个错误信息与真实原因无关。先无条件清掉同名库。
    await db.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
    await db.$client.unsafe(`create database "${scratchDatabase}"`)
    const created = createDb(scratchUrl)
    await migrate(created, { migrationsFolder })
    scratch = created
  }
  return scratch
}

// 每个测试文件都会建自己的连接池。不关掉的话，`bun test` 并行跑全量测试会把本地 PG 的
// max_connections（默认 100）顶爆，表现为 53300 `too many clients already`——那时失败的是
// 恰好抢不到连接的那个文件，看上去像随机的 flaky。
afterAll(async () => {
  if (scratch) {
    await scratch.$client.close()
    await db.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  }
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

async function jobRow(id: string, executor: Db = db) {
  const rows = await executor
    .select({
      status: jobs.status,
      attempts: jobs.attempts,
      lastError: jobs.lastError,
      lockedAt: jobs.lockedAt,
    })
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

/**
 * 僵死领取的回收（#43 的"重启后可继续"）。
 *
 * 这里**直接构造 `RUNNING` 行**，模拟"被领取后进程被 kill -9"。真正的崩溃窗口
 * （`claimNext` 的 UPDATE 之后、handler 返回之前）在本仓无法可重复地命中：handler 是毫秒级、
 * 没有可注入的阻塞点，抢在那几毫秒里杀进程只会得到一个 flaky 测试。构造崩溃后的**状态**才是
 * 可重复的做法；`core-smoke.ts` 里的重启恢复走的是同一种构造。这条链路的诚实边界写在这里，
 * 不要在别处声称"真实崩溃已被端到端验证"。
 *
 * 回收是**全表** UPDATE，所以这组用例跑在独立 scratch 库上（见文件头的说明），
 * 断言也因此可以要求精确条数。
 */
async function withRunningJob(
  options: { attempts: number },
  run: (jobId: string, queue: ReturnType<typeof createJobQueue>, isolated: Db) => Promise<void>,
): Promise<void> {
  const isolated = await scratchDb()
  const jobId = newId()
  await isolated.insert(jobs).values({
    id: jobId,
    type: 'MATCH_LISTING',
    payload: { listingId: newId() },
    // 模拟"被领取后进程死掉"：RUNNING + locked_at 有值。
    status: 'RUNNING',
    attempts: options.attempts,
    lockedAt: new Date(),
    runAt: new Date('2000-01-01T00:00:00Z'),
  })

  const queue = createJobQueue(isolated, {
    handlers: { MATCH_LISTING: async (payload) => ({ received: payload }) },
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
  })

  try {
    await run(jobId, queue, isolated)
  } finally {
    await isolated.delete(jobs).where(sql`${jobs.id} = ${jobId}`)
  }
}

test('启动回收把未达上限的 RUNNING job 放回 PENDING，之后可被重新领取并跑完', async () => {
  await withRunningJob({ attempts: 1 }, async (jobId, queue, isolated) => {
    expect(await queue.recoverStaleClaims()).toEqual({ requeued: 1, failed: 0 })
    // `locked_at` 必须一起清掉：这行已经不再被任何 worker 持有。
    expect(await jobRow(jobId, isolated)).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      lastError: null,
      lockedAt: null,
    })

    // 回收的意义就在这里：重启后的 worker 能再次领到它并跑到 DONE。
    await isolated.execute(sql`update jobs set run_at = '2000-01-01' where id = ${jobId}`)
    expect((await queue.runOnce())?.id).toBe(jobId)
    expect(await jobRow(jobId, isolated)).toMatchObject({
      status: 'DONE',
      attempts: 2,
      lockedAt: null,
    })
  })
})

test('启动回收把已达上限的 RUNNING job 直接置 FAILED，并写明原因', async () => {
  await withRunningJob({ attempts: DEFAULT_MAX_ATTEMPTS }, async (jobId, queue, isolated) => {
    expect(await queue.recoverStaleClaims()).toEqual({ requeued: 0, failed: 1 })
    // `locked_at` 同样要清：已 FAILED 的行不应看起来“还被持有”。
    expect(await jobRow(jobId, isolated)).toMatchObject({
      status: 'FAILED',
      attempts: DEFAULT_MAX_ATTEMPTS,
      lastError: STALE_CLAIM_ERROR,
      lockedAt: null,
    })

    // 已经不是 RUNNING，再回收一次不会把它拉回队列（也不会重复计数到 failed）。
    expect(await queue.recoverStaleClaims()).toEqual({ requeued: 0, failed: 0 })
    expect(await jobRow(jobId, isolated)).toMatchObject({
      status: 'FAILED',
      attempts: DEFAULT_MAX_ATTEMPTS,
      lastError: STALE_CLAIM_ERROR,
    })
  })
})

test('启动回收只动 RUNNING 行，不碰 PENDING / DONE', async () => {
  const isolated = await scratchDb()
  const pendingId = newId()
  const doneId = newId()
  await isolated.insert(jobs).values([
    {
      id: pendingId,
      type: 'MATCH_LISTING',
      payload: { listingId: newId() },
      status: 'PENDING',
      attempts: 1,
      runAt: new Date('2000-01-01T00:00:00Z'),
    },
    {
      id: doneId,
      type: 'MATCH_LISTING',
      payload: { listingId: newId() },
      status: 'DONE',
      attempts: 1,
      runAt: new Date('2000-01-01T00:00:00Z'),
    },
  ])

  try {
    expect(await createJobQueue(isolated, { handlers: {} }).recoverStaleClaims()).toEqual({
      requeued: 0,
      failed: 0,
    })
    expect(await jobRow(pendingId, isolated)).toMatchObject({ status: 'PENDING', attempts: 1 })
    expect(await jobRow(doneId, isolated)).toMatchObject({ status: 'DONE', attempts: 1 })
  } finally {
    await isolated.delete(jobs).where(sql`${jobs.id} = ${pendingId} or ${jobs.id} = ${doneId}`)
  }
})
