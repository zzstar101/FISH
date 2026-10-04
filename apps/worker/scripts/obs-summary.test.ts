/**
 * #322 M4 §12.1 缺口 #2 的回归：补投额度用尽此前只写一行 stderr（`embed.retry`，
 * `reason='budget-exhausted'`），事后没人能回答"现在有哪些实体已经不再自动重试了"。
 * 本文件跑**真的** `obs:summary`（`Bun.spawn`，与 `recommendation-cleanup.test.ts` 同一手法），
 * 断言额度用尽变成了可查询/可聚合的输出：`obs.retries` 明细 + `obs.summary` 的两个计数。
 *
 * 这条断言在修复前会红：脚本能跑通、退出码 0，但根本没有 `obs.retries` 这一组事件。
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { createDb } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { sql } from 'drizzle-orm'

// 与 packages/db 的集成测试同一约定：没有 DATABASE_URL 就明确失败，而不是静默跳过。
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const db = createDb(databaseUrl)
const scriptPath = Bun.fileURLToPath(new URL('./obs-summary.ts', import.meta.url))
const repoRoot = Bun.fileURLToPath(new URL('../../../', import.meta.url))
/** 显式给模型名，免得用例依赖 `EMBEDDING_TRANSPORT` / `EMBEDDING_MODEL` 的配置。 */
const MODEL = 'obs-summary-test'

/**
 * 本文件建过的 job id。`jobs` 没有到业务表的外键（payload 是 jsonb），必须自己删干净：
 * 留下的 `PENDING` 行会被**别的测试文件**的 `claimNext` 领走（队列不按类型过滤）。
 */
const createdJobIds: string[] = []

afterAll(async () => {
  try {
    if (createdJobIds.length > 0) {
      await db.execute(sql`
        DELETE FROM jobs WHERE id IN (${sql.join(
          createdJobIds.map((id) => sql`${id}`),
          sql`, `,
        )})
      `)
    }
  } finally {
    await db.$client.close()
  }
})

/** payload 必须走 `::text::jsonb` 两段转型（裸对象会落成 jsonb 字符串标量，`payload->>'…'` 恒 NULL）。 */
async function insertJob(fields: {
  type: string
  payload: Record<string, unknown>
  status: 'PENDING' | 'DONE' | 'FAILED'
}): Promise<void> {
  const id = newId()
  createdJobIds.push(id)
  await db.execute(sql`
    INSERT INTO jobs (id, type, payload, status, attempts, last_error)
    VALUES (${id}, ${fields.type}, ${JSON.stringify(fields.payload)}::text::jsonb, ${fields.status},
            ${fields.status === 'PENDING' ? 0 : 3}, 'test-fixture')
  `)
}

type Event = Record<string, unknown> & { event: string }

/** 跑一次真的 `obs:summary`，把 stdout 的每行 JSON 按事件名收成 map（stderr 只用于报错）。 */
async function runObsSummary(): Promise<Map<string, Event>> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  const proc = Bun.spawn(['bun', 'run', scriptPath, `--model=${MODEL}`], {
    cwd: repoRoot,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  if (exitCode !== 0) throw new Error(`obs:summary 退出码 ${exitCode}：${stderr}`)

  const events = new Map<string, Event>()
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    const parsed = JSON.parse(trimmed) as Event
    if (typeof parsed.event === 'string') events.set(parsed.event, parsed)
  }
  return events
}

describe('obs:summary 把"补投额度用尽"变成可查询的计数（缺口 #2）', () => {
  // 这条要 `Bun.spawn` 一个 bun 进程跑真脚本（还要连库聚合），机器忙时 5 s 的默认上限不够。
  test('额度用尽的实体出现在 obs.retries，并计入 obs.summary 的两个计数', async () => {
    // 自动路径已断：3 条 FAILED、没有待跑任务。
    const stuck = newId()
    for (let i = 0; i < 3; i++) {
      await insertJob({ type: 'EMBED_LISTING', payload: { listingId: stuck }, status: 'FAILED' })
    }
    // 额度也用尽，但用户又编辑了一次 ⇒ 还有待跑的 EMBED_LISTING。
    const stillQueued = newId()
    for (let i = 0; i < 3; i++) {
      await insertJob({
        type: 'EMBED_LISTING',
        payload: { listingId: stillQueued },
        status: 'FAILED',
      })
    }
    await insertJob({
      type: 'EMBED_LISTING',
      payload: { listingId: stillQueued },
      status: 'PENDING',
    })

    const events = await runObsSummary()

    const retries = events.get('obs.retries')
    if (!retries) {
      throw new Error(
        'obs:summary 没有 obs.retries 事件：额度用尽仍然只有 stderr 一行（缺口 #2 未修）',
      )
    }
    const entities = retries.entities as Event[]
    expect(entities.find((row) => row.entityId === stuck)).toMatchObject({
      jobType: 'EMBED_LISTING',
      entityKey: 'listingId',
      failedInWindow: 3,
      pending: false,
    })
    expect(entities.find((row) => row.entityId === stillQueued)).toMatchObject({
      jobType: 'EMBED_LISTING',
      entityKey: 'listingId',
      failedInWindow: 3,
      pending: true,
    })

    // 共享的开发库上别的行也可能额度用尽 ⇒ 只断言下界（本文件造的两条一定在里面）。
    const summary = events.get('obs.summary')
    const exhausted = Number(summary?.exhaustedEmbedRetries)
    const stuckCount = Number(summary?.stuckEmbedRetries)
    expect(exhausted).toBeGreaterThanOrEqual(2)
    expect(stuckCount).toBeGreaterThanOrEqual(1)
    expect(exhausted).toBeGreaterThanOrEqual(stuckCount)
  }, 30_000)
})
