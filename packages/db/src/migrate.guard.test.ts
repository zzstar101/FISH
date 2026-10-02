import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { createDb } from './client'
import type { JournalEntryRef } from './journal-alignment'
import { assertJournalAlignment, migrateWithBackfill } from './migrate'

/**
 * #429 的**接线**用例：`assertJournalAlignment` 本身（读写库 + 抛/不抛的决策）。
 *
 * 为什么要单独覆盖：判据 `findJournalDrift` 是纯函数、已有用例，但「漂移库在跑 drizzle 之前
 * 失败」这条验收标准落在**接线**上 —— 把 migrate.ts 里那次 `assertJournalAlignment(...)` 调用
 * 整行删掉，纯函数用例照样全绿。这里用打桩的 `db`（两次 `execute` 依次返回「有没有簿记表」
 * 与「库内簿记行」）把这条接线钉住，不必起真库。
 */

/** 依次返回给定响应；`rowsOf` 认得裸数组。 */
function stubDb(responses: unknown[]): Pick<ReturnType<typeof createDb>, 'execute'> {
  let index = 0
  return {
    execute: async () => responses[index++],
  } as unknown as Pick<ReturnType<typeof createDb>, 'execute'>
}

function hash(seed: string): string {
  return seed.repeat(64).slice(0, 64)
}

const BOOKKEEPING_TABLE = [{ name: 'drizzle.__drizzle_migrations' }]

test('#429 有 replay-hazard 时抛错，且信息点名 tag / 水位 / 修法', async () => {
  const entries: JournalEntryRef[] = [
    { tag: '0001_mighty', when: 200, hash: hash('a') },
    { tag: '0002_parched', when: 300, hash: hash('b') },
  ]
  const db = stubDb([
    BOOKKEEPING_TABLE,
    [
      { hash: hash('a'), created_at: 200 },
      { hash: hash('b'), created_at: 100 }, // #401 的形状：已应用，但 created_at 低于水位
    ],
  ])

  const error = await assertJournalAlignment(db, entries).then(
    () => null,
    (thrown: unknown) => thrown as Error,
  )
  expect(error).not.toBeNull()
  expect(error?.message).toContain('0002_parched')
  expect(error?.message).toContain('在跑 drizzle 之前停止')
  expect(error?.message).toContain('水位 200')
})

test('#429 只有告警类时不抛，但把告警打出来（不静默吞掉）', async () => {
  const entries: JournalEntryRef[] = [{ tag: '0001_a', when: 100, hash: hash('a') }]
  const db = stubDb([
    BOOKKEEPING_TABLE,
    [
      { hash: hash('a'), created_at: 100 },
      { hash: hash('z'), created_at: 50 }, // stale-row
    ],
  ])

  const warned: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => warned.push(args.join(' '))
  try {
    await expect(assertJournalAlignment(db, entries)).resolves.toBeUndefined()
  } finally {
    console.warn = original
  }

  expect(warned.join('\n')).toContain('不属于任何 journal 条目')
})

test('#429 全新库（没有簿记表）直接返回，不多查一次也不报错', async () => {
  let calls = 0
  const db = {
    execute: async () => {
      calls += 1
      return [{}]
    },
  } as unknown as Pick<ReturnType<typeof createDb>, 'execute'>

  await expect(assertJournalAlignment(db, [])).resolves.toBeUndefined()
  expect(calls).toBe(1)
})

test('#429 对齐库：两次查询都走完且不抛', async () => {
  const entries: JournalEntryRef[] = [{ tag: '0001_a', when: 100, hash: hash('a') }]
  const db = stubDb([BOOKKEEPING_TABLE, [{ hash: hash('a'), created_at: 100 }]])

  await expect(assertJournalAlignment(db, entries)).resolves.toBeUndefined()
})

/**
 * 端到端接线：真起一个 scratch 库，走 `migrateWithBackfill` 本身。
 *
 * 上面那组打桩用例只覆盖 `assertJournalAlignment`；把 `migrateWithBackfill` 里那次调用
 * 整行删掉，它们照样全绿。这条用例把**调用点**钉住：构造 #401 形状后，
 * `migrateWithBackfill` 必须 reject 且信息可读。
 */
const databaseUrl = process.env.DATABASE_URL
const scratchDatabase = `fish_journal_guard_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl ?? '')
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

test('#429 漂移库：migrateWithBackfill 在跑 drizzle 之前拒绝（#401 形状）', async () => {
  if (!databaseUrl) throw new Error('需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
  const admin = createDb(databaseUrl)
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  try {
    // 先完整迁移两次：对齐库上必须照常通过（正向对照，也顺带钉住幂等）。
    await migrateWithBackfill(scratchUrl)
    await migrateWithBackfill(scratchUrl)

    // 构造 #401 形状：把最后一条迁移的 created_at 压到倒数第二条之下 ——
    // 水位因此落到倒数第二条，而最后那条的 hash 仍留在库内 → drizzle 会重放它。
    const journal = JSON.parse(
      await readFile(join(import.meta.dir, 'migrations/meta/_journal.json'), 'utf8'),
    ) as { entries: { tag: string; when: number }[] }
    const last = journal.entries[journal.entries.length - 1]
    const secondLast = journal.entries[journal.entries.length - 2]
    if (!last || !secondLast) throw new Error('journal 条目不足')
    const lastHash = Bun.CryptoHasher.hash(
      'sha256',
      await readFile(join(import.meta.dir, `migrations/${last.tag}.sql`), 'utf8'),
      'hex',
    )
    const scratch = createDb(scratchUrl)
    await scratch.execute(sql`
      UPDATE drizzle.__drizzle_migrations SET created_at = ${secondLast.when - 1000}
      WHERE hash = ${lastHash}
    `)

    const error = await migrateWithBackfill(scratchUrl).then(
      () => null,
      (thrown: unknown) => thrown as Error,
    )
    expect(error).not.toBeNull()
    expect(error?.message).toContain('已在跑 drizzle 之前停止')
    expect(error?.message).toContain(last.tag)
    expect(error?.message).toContain(`水位 ${secondLast.when}`)
  } finally {
    await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  }
})
