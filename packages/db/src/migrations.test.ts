import { afterAll, expect, test } from 'bun:test'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from '@fish/db/client'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { migrateWithBackfill } from './migrate'

/**
 * #147 迁移回归：**旧语义下已过期的凭证不得在 drop column 后复活**。
 *
 * 旧 schema 允许存在 `PENDING_MEETUP + consumed_at IS NULL + expires_at <= now()` 的行，
 * 服务层把它派生为 EXPIRED（不可核销）。0016 直接 drop `expires_at` 后，同一行会被新代码
 * 派生为 ISSUED —— 已失效的历史 6 位码 / QR token 会重新变成长期有效凭证。
 * 因此 0015 必须在 drop 之前清理这类行。
 *
 * 用例走**真实 migrator**（两阶段）：先只应用到 0014 的目录，插入旧 schema 数据，
 * 再用完整目录把 0015 / 0016 应用上去——即「迁移真实发生在一个已有旧数据的库上」，
 * 而不是「空库跑全量迁移」。
 */
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('迁移回归测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const migrationsFolder = Bun.fileURLToPath(new URL('./migrations', import.meta.url))
const scratchDatabase = `fish_migration_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const admin = createDb(databaseUrl)

/** 只含 0000..0014 的迁移目录：让 scratch 库停在「旧 schema」上，便于灌入旧数据。 */
async function buildLegacyMigrationsFolder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fish-migrations-legacy-'))
  await mkdir(join(dir, 'meta'), { recursive: true })
  const journal = JSON.parse(
    await readFile(join(migrationsFolder, 'meta/_journal.json'), 'utf8'),
  ) as {
    entries: { idx: number; tag: string }[]
  }
  const legacy = journal.entries.filter((entry) => entry.idx <= 14)
  // `folderMillis`（journal 的 when）必须原样保留：migrator 用它判断待应用集合，
  // 第二阶段只应用 when 更大的 0015 / 0016。
  for (const entry of legacy) {
    await copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`))
  }
  await writeFile(
    join(dir, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: legacy }, null, 2),
  )
  return dir
}

/** 旧 schema 下的四行凭证：分别覆盖「已过期」「仍有效」「已消费」「终态交易」四种历史数据。 */
const ids = {
  buyer: '01990000-0000-7000-8000-000000000f01',
  seller: '01990000-0000-7000-8000-000000000f02',
  listingExpired: '01990000-0000-7000-8000-000000000f11',
  listingValid: '01990000-0000-7000-8000-000000000f12',
  listingConsumed: '01990000-0000-7000-8000-000000000f13',
  listingTerminal: '01990000-0000-7000-8000-000000000f14',
  convExpired: '01990000-0000-7000-8000-000000000f21',
  convValid: '01990000-0000-7000-8000-000000000f22',
  convConsumed: '01990000-0000-7000-8000-000000000f23',
  convTerminal: '01990000-0000-7000-8000-000000000f24',
  txExpired: '01990000-0000-7000-8000-000000000f31',
  txValid: '01990000-0000-7000-8000-000000000f32',
  txConsumed: '01990000-0000-7000-8000-000000000f33',
  txTerminal: '01990000-0000-7000-8000-000000000f34',
} as const

test('#147 迁移：旧语义下已过期的凭证被清理，不复活成长期有效；已消费行保留', async () => {
  const legacyFolder = await buildLegacyMigrationsFolder()
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  const scratch = createDb(scratchUrl)

  try {
    // ---- 阶段一：只应用 0000..0014，得到旧 schema ----
    await migrate(scratch, { migrationsFolder: legacyFolder })

    // ---- 灌入旧 schema 数据 ----
    await scratch.execute(sql`
      INSERT INTO users (id, student_no, password_hash, nickname) VALUES
        (${ids.buyer}, '202199010001', 'x', '买家'),
        (${ids.seller}, '202199010002', 'x', '卖家')
    `)
    for (const [listingId, sellerId] of [
      [ids.listingExpired, ids.seller],
      [ids.listingValid, ids.seller],
      [ids.listingConsumed, ids.seller],
      [ids.listingTerminal, ids.seller],
    ] as const) {
      await scratch.execute(sql`
        INSERT INTO listings (id, seller_id, title, description, price_cents, category, condition, status)
        VALUES (${listingId}, ${sellerId}, '旧数据商品', '迁移回归', 1000, 'DIGITAL', 'GOOD', 'RESERVED')
      `)
    }
    for (const [conversationId, listingId] of [
      [ids.convExpired, ids.listingExpired],
      [ids.convValid, ids.listingValid],
      [ids.convConsumed, ids.listingConsumed],
      [ids.convTerminal, ids.listingTerminal],
    ] as const) {
      await scratch.execute(sql`
        INSERT INTO conversations (id, listing_id, buyer_id, seller_id)
        VALUES (${conversationId}, ${listingId}, ${ids.buyer}, ${ids.seller})
      `)
    }
    // 三笔 PENDING_MEETUP + 一笔 COMPLETED（旧语义下终态也可能残留凭证行）
    await scratch.execute(sql`
      INSERT INTO transactions (id, listing_id, buyer_id, seller_id, amount_cents, status)
      VALUES
        (${ids.txExpired}, ${ids.listingExpired}, ${ids.buyer}, ${ids.seller}, 1000, 'PENDING_MEETUP'),
        (${ids.txValid}, ${ids.listingValid}, ${ids.buyer}, ${ids.seller}, 1000, 'PENDING_MEETUP'),
        (${ids.txConsumed}, ${ids.listingConsumed}, ${ids.buyer}, ${ids.seller}, 1000, 'PENDING_MEETUP')
    `)
    await scratch.execute(sql`
      INSERT INTO transactions (id, listing_id, buyer_id, seller_id, amount_cents, status, completed_at)
      VALUES (${ids.txTerminal}, ${ids.listingTerminal}, ${ids.buyer}, ${ids.seller}, 1000, 'COMPLETED', now())
    `)
    // 四种历史凭证行（旧 schema 的 expires_at 是 NOT NULL，且带
    // `expires_at > issued_at` CHECK，因此「已过期」的行必须把 issued_at 一并前移）
    await scratch.execute(sql`
      INSERT INTO transaction_meetup_tokens
        (transaction_id, token_hash, code_hash, issued_by, issued_at, expires_at)
      VALUES
        (${ids.txExpired}, 'expired-token', 'expired-code', ${ids.seller},
          now() - interval '10 minutes', now() - interval '5 minutes'),
        (${ids.txValid}, 'valid-token', 'valid-code', ${ids.seller},
          now(), now() + interval '5 minutes'),
        (${ids.txConsumed}, 'consumed-token', 'consumed-code', ${ids.seller},
          now() - interval '10 minutes', now() - interval '5 minutes'),
        (${ids.txTerminal}, 'terminal-token', 'terminal-code', ${ids.seller},
          now(), now() + interval '5 minutes')
    `)
    // 已消费行：旧语义下 CONSUMED 与过期无关
    await scratch.execute(sql`
      UPDATE transaction_meetup_tokens SET consumed_at = now(), consumed_by = ${ids.buyer}
      WHERE transaction_id = ${ids.txConsumed}
    `)

    const before = await scratch.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM transaction_meetup_tokens`,
    )
    expect(Number([...before][0]?.n)).toBe(4) // 前置条件：旧数据确实灌进去了

    // ---- 阶段二：应用 0015（清理）与 0016（drop column）----
    await migrateWithBackfill(scratchUrl)

    // ① 旧语义下已过期、未消费的行必须被清理（否则 drop column 后复活成 ISSUED）
    const expiredRow = await scratch.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM transaction_meetup_tokens WHERE transaction_id = ${ids.txExpired}`,
    )
    expect(Number([...expiredRow][0]?.n)).toBe(0)

    // ② 迁移时仍有效、未消费的行保留（在新语义下成为长期凭证——这是刻意的语义变化）
    const validRow = await scratch.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM transaction_meetup_tokens WHERE transaction_id = ${ids.txValid}`,
    )
    expect(Number([...validRow][0]?.n)).toBe(1)

    // ③ 已消费行保留：它承担「核销成功但买家 confirm 网络失败」的恢复语义，
    //    不能因为 expires_at 已过就被清掉（Owner 明确要求不要整表清空）
    const consumedRow = await scratch.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM transaction_meetup_tokens WHERE transaction_id = ${ids.txConsumed}`,
    )
    expect(Number([...consumedRow][0]?.n)).toBe(1)

    // ④ 终态交易上的遗留行不在本迁移清理范围（由 getMeetupTokenStatus 的终态守卫兜住），
    //    这里断言它仍在，避免未来把清理条件放宽成「按交易状态删」
    const terminalRow = await scratch.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM transaction_meetup_tokens WHERE transaction_id = ${ids.txTerminal}`,
    )
    expect(Number([...terminalRow][0]?.n)).toBe(1)

    // ⑤ expires_at 列确已删除（新 schema 落地）
    const column = await scratch.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name = 'transaction_meetup_tokens' AND column_name = 'expires_at'
    `)
    expect(Number([...column][0]?.n)).toBe(0)

    // ⑥ 安全不变量（本用例的核心）：迁移后不存在「交易仍 PENDING_MEETUP、未消费」
    //    且「迁移时已过期」的行——即没有旧失效凭证被新语义解释成可用凭证。
    //    expires_at 已 drop，故用「阶段一遗留的过期集合」间接断言：那唯一一行已被删除，
    //    其余存活的未消费行都来自 txValid。
    const survivingUnconsumed = await scratch.execute<{ transaction_id: string }>(sql`
      SELECT transaction_id FROM transaction_meetup_tokens WHERE consumed_at IS NULL
    `)
    expect([...survivingUnconsumed].map((row) => row.transaction_id).sort()).toEqual(
      [ids.txTerminal, ids.txValid].sort(),
    )
  } finally {
    await scratch.$client.close()
    await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
    await rm(legacyFolder, { recursive: true, force: true })
  }
})

afterAll(async () => {
  await admin.$client.close()
})
