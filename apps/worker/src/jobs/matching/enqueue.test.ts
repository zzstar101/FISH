/**
 * #322 M4 §12.1「工程缺口一」的回归：`MATCH_LISTING` 的 partial unique index
 * （`jobs_match_listing_listing_id_pending_uidx`，见 `packages/db/src/schema/jobs.ts`）。
 *
 * 修复前的行为：投递侧（`apps/api/src/modules/listings/store.ts` 等处）是**裸 INSERT**，
 * worker 侧 `enqueueMatchJob` 只靠 `WHERE NOT EXISTS (… status = 'PENDING')` 去重——同一个
 * listing 可以同时存在多条待跑 `MATCH_LISTING`（重复插入直接多一行；并发下两个插入者可以
 * 同时通过 `NOT EXISTS`）。本文件三条用例在加索引前都会红。
 *
 * 走 scratch 库（每 PID 一个）+ 真实 migrator，而不是开发库：第三条用例需要"停在缺口一那两条
 * 迁移之前"的旧 schema，只能靠临时迁移目录做到。
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb, type Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { toRows } from '../queue'
import { enqueueMatchJob } from './enqueue'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../../../packages/db/src/migrations', import.meta.url),
)

const scratchDatabase = `fish_match_enqueue_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const admin = createDb(databaseUrl)
const db = createDb(scratchUrl)
/** 第四条用例造的临时迁移目录：`afterAll` 里删掉，别在 /tmp 留垃圾。 */
const tempFolders: string[] = []

/**
 * 缺口一那两条迁移的 tag（顺序即：先清重复行 `dedupe_pending_match_listing_jobs`，再建唯一索引）。
 * 这两个名字是 drizzle-kit 生成的随机名——下面用它把"缺口一之前"的迁移目录切出来；名字一旦对不上，
 * 临时目录就等于全量目录，第四条用例会直接红（不会静默通过）。
 */
const GAP_MIGRATION_TAGS = new Set([
  '20261004193147_dedupe_pending_match_listing_jobs',
  '20261004193208_ordinary_bucky',
])

/** 与投递侧同形的裸 INSERT：没有 `ON CONFLICT`，重复就是撞唯一索引。 */
async function insertRawPendingMatchListing(
  target: Pick<Db, 'execute'>,
  listingId: string,
): Promise<void> {
  await target.execute(sql`
    INSERT INTO jobs (id, type, payload)
    VALUES (${newId()}, 'MATCH_LISTING', ${JSON.stringify({ listingId })}::text::jsonb)
  `)
}

async function pendingIds(target: Pick<Db, 'execute'>, listingId: string): Promise<string[]> {
  const rows = await target.execute(sql`
    SELECT id FROM jobs
    WHERE type = 'MATCH_LISTING' AND status = 'PENDING'
      AND payload->>'listingId' = ${listingId}
    ORDER BY id
  `)
  return toRows(rows).map((row) => String(row.id))
}

/**
 * drizzle 的 `db.execute()` 返回自定义 thenable，bun:test 的 `rejects` 不认；且 drizzle 把驱动
 * 错误包成 `Failed query: …`，真正的原因挂在 cause 链上——所以手工 try/catch 后拼整条链匹配。
 */
async function expectSqlRejected(run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await run()
  } catch (error) {
    const chain: string[] = []
    let current: unknown = error
    while (current instanceof Error) {
      chain.push(current.message)
      current = current.cause
    }
    expect(chain.join('\n')).toMatch(pattern)
    return
  }
  throw new Error(`期望 SQL 被拒绝（${pattern}），但执行成功了`)
}

// 钩子里要跑一遍完整 migrator（43 条迁移，本机实测 ~5-7 s），超过 bun 默认的 5 s 钩子上限；
// 收尾还要 `drop database ... with (force)`。两条都显式放宽，免得"机器忙"被误报成用例失败。
beforeAll(async () => {
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  await migrate(db, { migrationsFolder })
}, 60_000)

afterAll(async () => {
  await Promise.all(tempFolders.map((dir) => rm(dir, { recursive: true, force: true })))
  await db.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
}, 60_000)

test('同一 listing 的第二条 PENDING MATCH_LISTING 被唯一索引拒绝，ON CONFLICT 可静默复用', async () => {
  const listingId = newId()

  await insertRawPendingMatchListing(db, listingId)
  await expectSqlRejected(
    () => insertRawPendingMatchListing(db, listingId),
    /jobs_match_listing_listing_id_pending_uidx/,
  )
  expect(await pendingIds(db, listingId)).toHaveLength(1)

  // 投递侧实际用的形状：撞唯一键不是错误，只是"已经排好队了"。
  await db.execute(sql`
    INSERT INTO jobs (id, type, payload)
    VALUES (${newId()}, 'MATCH_LISTING', ${JSON.stringify({ listingId })}::text::jsonb)
    ON CONFLICT DO NOTHING
  `)
  expect(await pendingIds(db, listingId)).toHaveLength(1)
})

test('终态行不占位：前一条 DONE 之后必须能再投一条', async () => {
  const listingId = newId()

  await insertRawPendingMatchListing(db, listingId)
  await db.execute(sql`
    UPDATE jobs SET status = 'DONE'
    WHERE type = 'MATCH_LISTING' AND status = 'PENDING' AND payload->>'listingId' = ${listingId}
  `)
  await insertRawPendingMatchListing(db, listingId)
  expect(await pendingIds(db, listingId)).toHaveLength(1)
})

test('并发 enqueueMatchJob：两个插入者同时通过 NOT EXISTS 也只留一条待跑行', async () => {
  const listingId = newId()

  // 第一个插入者持有未提交事务（去重查询看不到它的行），第二个插入者此刻也能通过 `NOT EXISTS`。
  const first = db.transaction(async (tx) => {
    await enqueueMatchJob(tx, { kind: 'listing', id: listingId })
    await Bun.sleep(300)
  })
  await Bun.sleep(80)
  const second = enqueueMatchJob(db, { kind: 'listing', id: listingId })

  await Promise.all([first, second])
  expect(await pendingIds(db, listingId)).toHaveLength(1)
})

// 这条要跑两遍完整 migrator（43 条迁移 × 2 个阶段），并行跑全仓时 5 s 的默认上限不够。
test('旧库已有重复待跑行时：迁移先清理重复行再建索引，随后重复插入被拒', async () => {
  const legacyFolder = await buildPreGapMigrationsFolder()
  const legacyDatabase = `fish_match_enqueue_legacy_${process.pid}`
  const legacyUrl = (() => {
    const url = new URL(databaseUrl)
    url.pathname = `/${legacyDatabase}`
    return url.toString()
  })()
  await admin.$client.unsafe(`drop database if exists "${legacyDatabase}" with (force)`)
  await admin.$client.unsafe(`create database "${legacyDatabase}"`)
  const legacy = createDb(legacyUrl)

  try {
    // 阶段一：停在缺口一之前 ⇒ 没有唯一索引，同一个 listing 堆出两条待跑行是合法的。
    await migrate(legacy, { migrationsFolder: legacyFolder })
    const listingId = newId()
    await insertRawPendingMatchListing(legacy, listingId)
    await insertRawPendingMatchListing(legacy, listingId)
    expect(await pendingIds(legacy, listingId)).toHaveLength(2)

    // 阶段二：应用缺口一的两条迁移（清重复行 → 建唯一索引），旧库不报错。
    await migrate(legacy, { migrationsFolder })
    expect(await pendingIds(legacy, listingId)).toHaveLength(1)
    await expectSqlRejected(
      () => insertRawPendingMatchListing(legacy, listingId),
      /jobs_match_listing_listing_id_pending_uidx/,
    )
  } finally {
    await legacy.$client.close()
    await admin.$client.unsafe(`drop database if exists "${legacyDatabase}" with (force)`)
  }
}, 30_000)

/** 只含缺口一那两条迁移**之前**的迁移目录：`when` 原样保留，第二阶段的 migrator 才会补应用。 */
async function buildPreGapMigrationsFolder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fish-migrations-pre-gap-'))
  tempFolders.push(dir)
  await mkdir(join(dir, 'meta'), { recursive: true })
  const journal = JSON.parse(
    await readFile(join(migrationsFolder, 'meta/_journal.json'), 'utf8'),
  ) as {
    entries: { idx: number; tag: string }[]
  }
  const legacy = journal.entries.filter((entry) => !GAP_MIGRATION_TAGS.has(entry.tag))
  for (const entry of legacy) {
    await copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`))
  }
  await writeFile(
    join(dir, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: legacy }, null, 2),
  )
  return dir
}
