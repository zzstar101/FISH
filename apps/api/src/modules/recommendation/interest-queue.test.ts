import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb, type Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { jobs } from '@fish/db/schema/jobs'
import { eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createDbInterestRefreshQueue } from './interest-queue'

/**
 * 长期画像重算投递（#323 R2）的集成测试：真实 Postgres + 真实 schema。
 *
 * 这条链只有两个失败模式，但都会**静默**发生：
 *
 * 1. **payload 不是 jsonb 对象**（`::jsonb` 双序列化的坑）→ 消费方 `payload->>'userId'` 读不到，
 *    部分唯一索引的表达式也失效，job 会永远跑不出结果。
 * 2. **幂等键的谓词写错**（漏掉 `status='PENDING'`）→ 第一条 DONE 的 job 永久占位，
 *    之后所有投递都被 `ON CONFLICT DO NOTHING` 吃掉，"行为变了就重算"从此不再发生。
 *
 * 所以这里不看 `enqueue` 的返回值（它没有返回值），而是**回库看 jobs 表里到底有什么**。
 */

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../../../packages/db/src/migrations', import.meta.url),
)

const scratchDatabase = `fish_interest_queue_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const admin = createDb(databaseUrl)
let db: Db

beforeAll(async () => {
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  db = createDb(scratchUrl)
  await migrate(db, { migrationsFolder })
})

afterAll(async () => {
  await db.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

type JobRow = { status: string; kind: string; userId: string | null }

/**
 * 直接看原始 jsonb：`jsonb_typeof` 能区分"对象"与"被双序列化成的字符串标量"。
 * 本文件的用例共用一个 scratch 库，所以查询一律按 userId 收口，避免上游用例的行混进来。
 */
async function readInterestJobs(userId: string): Promise<JobRow[]> {
  const rows = await db.execute(sql`
    select
      status,
      jsonb_typeof(payload) as kind,
      payload->>'userId' as "userId"
    from jobs
    where type = 'REFRESH_USER_INTEREST'
      and payload->>'userId' = ${userId}
    order by created_at, id
  `)
  return [...rows] as JobRow[]
}

/**
 * 造一条别的状态的同用户 job，用来验证幂等键只锁 PENDING。
 *
 * 用原始 SQL 而不是 drizzle 的 `.insert()`：本仓的 drizzle + bun-sql 会把 JS 对象再序列化一次，
 * 落成 jsonb **字符串标量**（`match-queue.ts` / `interest-queue.ts` 都记着这个坑）。
 * 这里的种子行必须与真实投递同形，否则 `payload->>'userId'` 读不到，用例会假装通过。
 */
async function insertJob(userId: string, status: 'RUNNING' | 'DONE' | 'FAILED'): Promise<void> {
  await db.execute(sql`
    INSERT INTO jobs (id, type, status, payload)
    VALUES (${newId()}, 'REFRESH_USER_INTEREST', ${status}, ${JSON.stringify({ userId })}::text::jsonb)
  `)
}

describe('createDbInterestRefreshQueue', () => {
  test('同一用户重复投递只留一条 PENDING，且 payload 是真 jsonb 对象', async () => {
    const userId = newId()
    const queue = createDbInterestRefreshQueue(db)

    await queue.enqueue(userId)
    await queue.enqueue(userId)
    await queue.enqueue(userId)

    const rows = await readInterestJobs(userId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({ status: 'PENDING', kind: 'object', userId })
  })

  test('不同用户各留一条，互不冲突', async () => {
    const first = newId()
    const second = newId()
    const queue = createDbInterestRefreshQueue(db)

    await queue.enqueue(first)
    await queue.enqueue(second)

    const firstRows = await readInterestJobs(first)
    const secondRows = await readInterestJobs(second)
    expect(firstRows).toHaveLength(1)
    expect(secondRows).toHaveLength(1)
    expect(firstRows[0]?.status).toBe('PENDING')
    expect(secondRows[0]?.status).toBe('PENDING')
  })

  test('已跑完（DONE）的旧 job 不阻碍新投递：幂等键只锁 PENDING', async () => {
    const userId = newId()
    await insertJob(userId, 'DONE')

    await createDbInterestRefreshQueue(db).enqueue(userId)

    const rows = await readInterestJobs(userId)
    expect(rows.map((row) => row.status).sort()).toEqual(['DONE', 'PENDING'])
  })

  test('正在跑（RUNNING）的同用户 job 不阻碍新投递（跑完后还能再重算）', async () => {
    const userId = newId()
    await insertJob(userId, 'RUNNING')

    await createDbInterestRefreshQueue(db).enqueue(userId)

    const rows = await readInterestJobs(userId)
    expect(rows.map((row) => row.status).sort()).toEqual(['PENDING', 'RUNNING'])
  })

  test('落库的行与消费方约定一致：type/status/payload 三样都对', async () => {
    const userId = newId()
    await createDbInterestRefreshQueue(db).enqueue(userId)

    const rows = await db.select().from(jobs).where(eq(jobs.type, 'REFRESH_USER_INTEREST'))
    const mine = rows.filter(
      (row) => (row.payload as { userId?: string } | null)?.userId === userId,
    )
    expect(mine).toHaveLength(1)
    expect(mine[0]?.payload).toEqual({ userId })
    expect(mine[0]?.status).toBe('PENDING')
  })
})
