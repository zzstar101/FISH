import { afterAll, describe, expect, test } from 'bun:test'
import { createDb } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { sql } from 'drizzle-orm'
import { scheduleFailedEmbedRetry } from './requeue'

// 与 packages/db 的集成测试同一约定：没有 DATABASE_URL 就明确失败，而不是静默跳过。
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const db = createDb(databaseUrl)
/**
 * 本文件建过的 job id。`jobs` 没有到业务表的外键（payload 是 jsonb），必须自己删干净：
 * 留下的 `PENDING` 行会被**别的测试文件**的 `claimNext` 领走（队列不按类型过滤）。
 */
const createdJobIds: string[] = []
const createdEntityIds = new Set<string>()

async function cleanupTestJobs(): Promise<void> {
  const filters: ReturnType<typeof sql>[] = []
  if (createdJobIds.length > 0) {
    filters.push(
      sql`id IN (${sql.join(
        createdJobIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    )
  }
  if (createdEntityIds.size > 0) {
    const owned = sql.join(
      [...createdEntityIds].map((id) => sql`${id}`),
      sql`, `,
    )
    filters.push(sql`payload->>'listingId' IN (${owned})`, sql`payload->>'wishId' IN (${owned})`)
  }
  if (filters.length > 0)
    await db.execute(sql`DELETE FROM jobs WHERE ${sql.join(filters, sql` OR `)}`)
}

afterAll(async () => {
  try {
    await cleanupTestJobs()
  } finally {
    await db.$client.close()
  }
})

/**
 * 直接写原始 SQL 造 job 行：与生产写入路径（`enqueue*.ts` / `settle()`）同形，
 * 且 payload 一定要走 `::text::jsonb` 两段转型——裸对象会落成 jsonb **字符串标量**，
 * `payload->>'listingId'` 恒为 NULL（`packages/db/src/json.ts` 记录过这个坑）。
 *
 * `ageMs` 用来把 `updated_at` 推到过去（测 24 小时窗口）。
 */
async function insertJob(fields: {
  type: string
  payload: Record<string, unknown>
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED'
  ageMs?: number
}): Promise<string> {
  const id = newId()
  createdJobIds.push(id)
  for (const key of ['listingId', 'wishId']) {
    const entityId = fields.payload[key]
    if (typeof entityId === 'string') createdEntityIds.add(entityId)
  }
  const ageSec = (fields.ageMs ?? 0) / 1000
  await db.execute(sql`
    INSERT INTO jobs (id, type, payload, status, attempts, last_error, run_at, updated_at)
    VALUES (${id}, ${fields.type}, ${JSON.stringify(fields.payload)}::text::jsonb, ${fields.status},
            ${fields.status === 'PENDING' ? 0 : 3}, 'test-fixture', now(),
            now() - make_interval(secs => ${ageSec}::double precision))
  `)
  return id
}

async function jobRow(id: string): Promise<Record<string, unknown> | undefined> {
  const rows = await db.execute(
    sql`SELECT id, type, payload, status, attempts, run_at, last_error FROM jobs WHERE id = ${id}`,
  )
  return (rows as Record<string, unknown>[])[0]
}

describe('scheduleFailedEmbedRetry：终结失败后的有界补投', () => {
  test('不是 EMBED_* 的失败不在这里补投', async () => {
    const id = await insertJob({
      type: 'MATCH_LISTING',
      payload: { listingId: newId() },
      status: 'FAILED',
    })
    expect(await scheduleFailedEmbedRetry(db, id)).toMatchObject({
      scheduled: false,
      reason: 'not-embed',
      type: 'MATCH_LISTING',
    })
  })

  test('行不存在或还没到 FAILED 时不动它', async () => {
    expect(await scheduleFailedEmbedRetry(db, newId())).toEqual({
      scheduled: false,
      type: null,
      entityKey: null,
      entityId: null,
      failedInWindow: 0,
      reason: 'not-failed',
      delayMs: null,
    })

    const pending = await insertJob({
      type: 'EMBED_LISTING',
      payload: { listingId: newId() },
      status: 'PENDING',
    })
    expect(await scheduleFailedEmbedRetry(db, pending)).toMatchObject({ reason: 'not-failed' })
  })

  test('payload 里没有实体 id 时不补投（坏 payload 不会自己变好）', async () => {
    const id = await insertJob({ type: 'EMBED_LISTING', payload: {}, status: 'FAILED' })
    expect(await scheduleFailedEmbedRetry(db, id)).toMatchObject({
      scheduled: false,
      reason: 'bad-payload',
      entityId: null,
    })
  })

  test('第一次失败：排一条延迟执行的同实体 EMBED_LISTING', async () => {
    const listingId = newId()
    const failed = await insertJob({
      type: 'EMBED_LISTING',
      payload: { listingId },
      status: 'FAILED',
    })

    const result = await scheduleFailedEmbedRetry(db, failed)
    expect(result).toMatchObject({
      scheduled: true,
      reason: null,
      type: 'EMBED_LISTING',
      entityKey: 'listingId',
      entityId: listingId,
      failedInWindow: 1,
      delayMs: 60_000,
    })

    // 新行必须**延后**才可领取（给上游恢复时间），且 payload 能被 `payload->>'listingId'` 命中
    // ——后者是补投是否真的生效的判据（双重序列化会让它恒为 NULL）。
    const rows = (await db.execute(sql`
      SELECT id, status, attempts, run_at > now() AS delayed,
             run_at <= now() + make_interval(secs => 61) AS roughly_one_minute,
             payload->>'listingId' AS listing_id
      FROM jobs
      WHERE type = 'EMBED_LISTING' AND status = 'PENDING' AND payload->>'listingId' = ${listingId}
    `)) as Record<string, unknown>[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'PENDING', attempts: 0, delayed: true })
    expect(rows[0]?.roughly_one_minute).toBe(true)
    expect(rows[0]?.listing_id).toBe(listingId)

    // 已有待跑任务时不重复投（编辑路径也是同一语义）：第二次调用只会得到 already-pending。
    expect(await scheduleFailedEmbedRetry(db, failed)).toMatchObject({
      scheduled: false,
      reason: 'already-pending',
      failedInWindow: 1,
    })
  })

  test('愿望侧同样补投 MATCH_WISH 的同实体键（wishId）', async () => {
    const wishId = newId()
    const failed = await insertJob({ type: 'EMBED_WISH', payload: { wishId }, status: 'FAILED' })
    expect(await scheduleFailedEmbedRetry(db, failed)).toMatchObject({
      scheduled: true,
      type: 'EMBED_WISH',
      entityKey: 'wishId',
      entityId: wishId,
    })
    const rows = (await db.execute(sql`
      SELECT payload->>'wishId' AS wish_id FROM jobs
      WHERE type = 'EMBED_WISH' AND status = 'PENDING' AND payload->>'wishId' = ${wishId}
    `)) as Record<string, unknown>[]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.wish_id).toBe(wishId)
  })

  test('额度到顶：24 小时内第 3 条 FAILED 起不再自动重试', async () => {
    const listingId = newId()
    const first = await insertJob({
      type: 'EMBED_LISTING',
      payload: { listingId },
      status: 'FAILED',
    })
    // 第 1 条失败：额度还有，补投。
    expect(await scheduleFailedEmbedRetry(db, first)).toMatchObject({
      scheduled: true,
      failedInWindow: 1,
    })

    // 第 2 条失败：额度还没到顶，但已经有待跑的那条 → 不重复投。
    const second = await insertJob({
      type: 'EMBED_LISTING',
      payload: { listingId },
      status: 'FAILED',
    })
    expect(await scheduleFailedEmbedRetry(db, second)).toMatchObject({
      scheduled: false,
      reason: 'already-pending',
      failedInWindow: 2,
    })

    // 第 3 条失败：额度用尽，后续不再自动重试（剩下的人工路径：`embed:backfill` + obs 告警）。
    const third = await insertJob({
      type: 'EMBED_LISTING',
      payload: { listingId },
      status: 'FAILED',
    })
    expect(await scheduleFailedEmbedRetry(db, third)).toMatchObject({
      scheduled: false,
      reason: 'budget-exhausted',
      failedInWindow: 3,
      delayMs: null,
    })
  })

  test('24 小时窗口外的旧失败不压额度（上游恢复后重新获得补投机会）', async () => {
    const listingId = newId()
    await insertJob({
      type: 'EMBED_LISTING',
      payload: { listingId },
      status: 'FAILED',
      ageMs: 25 * 60 * 60 * 1000,
    })
    await insertJob({
      type: 'EMBED_LISTING',
      payload: { listingId },
      status: 'FAILED',
      ageMs: 25 * 60 * 60 * 1000,
    })
    const fresh = await insertJob({
      type: 'EMBED_LISTING',
      payload: { listingId },
      status: 'FAILED',
    })

    expect(await scheduleFailedEmbedRetry(db, fresh)).toMatchObject({
      scheduled: true,
      failedInWindow: 1,
    })
  })

  test('补投的行是独立的普通 job：可以被全新领取（attempts 从 0 开始）', async () => {
    const listingId = newId()
    const failed = await insertJob({
      type: 'EMBED_LISTING',
      payload: { listingId },
      status: 'FAILED',
    })
    const result = await scheduleFailedEmbedRetry(db, failed)
    expect(result.scheduled).toBe(true)

    const pending = (await db.execute(sql`
      SELECT id FROM jobs
      WHERE type = 'EMBED_LISTING' AND status = 'PENDING' AND payload->>'listingId' = ${listingId}
    `)) as Record<string, unknown>[]
    const newJobId = String(pending[0]?.id)
    expect(newJobId).not.toBe(failed)
    expect(await jobRow(failed)).toMatchObject({ status: 'FAILED' })
    expect(await jobRow(newJobId)).toMatchObject({ status: 'PENDING', attempts: 0 })
  })

  test('测试清理覆盖生产函数补投的新 job，而不只删除原始失败行', async () => {
    const listingId = newId()
    const failed = await insertJob({
      type: 'EMBED_LISTING',
      payload: { listingId },
      status: 'FAILED',
    })
    expect((await scheduleFailedEmbedRetry(db, failed)).scheduled).toBe(true)
    await cleanupTestJobs()
    const remaining = await db.execute(
      sql`SELECT id FROM jobs WHERE payload->>'listingId' = ${listingId}`,
    )
    expect([...remaining]).toHaveLength(0)
  })
})
