import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { backfillIds } from './backfill-ids'
import { createDb } from './client'
import {
  type AppliedMigrationRow,
  blockingDrift,
  findJournalDrift,
  formatJournalDrift,
  type JournalEntryRef,
} from './journal-alignment'
import { rekeyLegacyIds } from './rekey-ids'

const folder = join(import.meta.dir, 'migrations')
const FIRST_PHASE = '0020_real_golden_guardian'
const CONSTRAINT_PHASE = '0021_whole_mister_sinister'
const GOVERNANCE_PHASE = '0022_lethal_oracle'

// Only this exact #73 migration lineage can be reconciled. Do not infer compatibility merely
// because a reports table exists: partially applied or unrelated forks must fail closed.
const legacyHashes = new Map([
  ['1790244241466', '4186b428f22a064a68953c2adc69ff57b9050127dbb378acfcf3528a24a35a17'],
  ['1790247805086', '23322a15c693512926508bee39ce6fa26aba00135d0878696844b1c6d1765e0d'],
  ['1790247978506', 'ac49fef245cacde735dce0e41209e33709b9736404f8cbb26cc6d22b7875b949'],
  ['1790249989690', '973c270f16deec28378edd4e6ef234e8f799e9b134fb4f92ae114cb2d3e15b1d'],
  ['1790250882677', 'c4da4846f45e06c8dbd299f2e77b765ad05d121f5e44dd630578598f698f5c36'],
])

type Journal = {
  version: string
  dialect: string
  entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[]
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && 'rows' in result && Array.isArray(result.rows)) {
    return result.rows as Record<string, unknown>[]
  }
  return []
}

async function hasLegacyGovernance(db: ReturnType<typeof createDb>): Promise<boolean> {
  const exists = rowsOf(
    await db.execute(sql`SELECT to_regclass('drizzle.__drizzle_migrations') AS name`),
  )[0]
  if (!exists?.name) return false
  const history = rowsOf(
    await db.execute(sql`
    SELECT hash, created_at FROM drizzle.__drizzle_migrations
    WHERE created_at BETWEEN 1790244241466 AND 1790250882677
    ORDER BY created_at
  `),
  )
  if (history.length === 0) return false
  // 0019 is shared by main and #73; only the four following entries identify the fork.
  if (
    history.length === 1 &&
    legacyHashes.get(String(history[0]?.created_at)) === history[0]?.hash
  ) {
    return false
  }
  if (
    history.length !== legacyHashes.size ||
    history.some((row) => legacyHashes.get(String(row.created_at)) !== row.hash)
  ) {
    throw new Error('检测到未知或不完整的 #73 数据库迁移历史；禁止自动升级')
  }
  return true
}

async function recognizeLegacyGovernance(
  db: ReturnType<typeof createDb>,
  entry: Journal['entries'][number],
): Promise<void> {
  const migrationSql = await Bun.file(join(folder, `${entry.tag}.sql`)).text()
  const hash = Bun.CryptoHasher.hash('sha256', migrationSql, 'hex')
  await db.transaction(async (tx) => {
    const existing = rowsOf(
      await tx.execute(sql`
      SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at = ${entry.when}
    `),
    )[0]
    if (existing) {
      if (existing.hash !== hash) throw new Error('治理阶段迁移哈希与当前生成文件不符')
      return
    }
    const schema = rowsOf(
      await tx.execute(sql`
      SELECT to_regclass('public.reports') IS NOT NULL AS reports,
             to_regclass('public.user_restrictions') IS NOT NULL AS restrictions,
             EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
               AND table_name = 'listings' AND column_name = 'governance_delisted_at') AS delisted
    `),
    )[0]
    if (!schema?.reports || !schema.restrictions || !schema.delisted) {
      throw new Error('旧 #73 治理结构缺失，禁止跳过生成的治理迁移')
    }
    // #73 already created the tables/enums/indexes. Its only structural delta from the
    // generated #217 phase is the database-side UUIDv7 defaults on these two primary keys.
    await tx.execute(sql`ALTER TABLE reports ALTER COLUMN id SET DEFAULT uuidv7()`)
    await tx.execute(sql`ALTER TABLE user_restrictions ALTER COLUMN id SET DEFAULT uuidv7()`)
    // Append the generated phase's hash/timestamp; never delete or rewrite #73 history.
    await tx.execute(sql`
      INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
      VALUES (${hash}, ${entry.when})
    `)
  })
}

/**
 * 把 journal 条目补上各自的 hash。实测 `Bun.CryptoHasher.hash('sha256', <迁移 .sql 原文>)`
 * 与 drizzle 写进 `drizzle.__drizzle_migrations.hash` 的值一致（#401 修复时 36 条逐一命中）。
 */
async function loadJournalEntryRefs(journal: Journal): Promise<JournalEntryRef[]> {
  const refs: JournalEntryRef[] = []
  for (const entry of journal.entries) {
    const migrationSql = await Bun.file(join(folder, `${entry.tag}.sql`)).text()
    refs.push({
      tag: entry.tag,
      when: entry.when,
      hash: Bun.CryptoHasher.hash('sha256', migrationSql, 'hex'),
    })
  }
  return refs
}

/**
 * 跑 drizzle 之前的**簿记对齐**校验（#429）。
 *
 * drizzle 0.45 不比对 hash、只按水位判重放，所以一条「内容早已应用、但簿记顺序错位」的迁移
 * 会被重放并炸出没有信息量的驱动错误（#401 实测 `enum label "LISTING" already exists`）。
 * 这里把它换成说清「哪条、为什么、怎么改」的失败。
 *
 * 阻断项：replay-hazard（drizzle 下一步必崩）、`created_at IS NULL` 的簿记行（水位被读成 0 ⇒ 整份
 * journal 重放）、以及 `created_at` 高于整份 journal 的陈旧行（drizzle 从此一条都不执行）。
 * 另几类只告警（判据与理由见 `./journal-alignment` 的文件头）。
 *
 * `entries` 由调用方传入而不是在这里读文件：这样判据的两半（取 journal / 比对库内簿记）
 * 各有单一职责，DB 这一半也能用打桩的 `db` 单测（含「有 hazard 则抛、只有告警则不抛」）。
 */
export async function assertJournalAlignment(
  db: Pick<ReturnType<typeof createDb>, 'execute'>,
  entries: readonly JournalEntryRef[],
  options: { legacyPreMigrationWhen?: number } = {},
): Promise<void> {
  const exists = rowsOf(
    await db.execute(sql`SELECT to_regclass('drizzle.__drizzle_migrations') AS name`),
  )[0]
  // 全新库没有簿记表：没有水位，谈不上漂移。
  if (!exists?.name) return

  const rows = rowsOf(
    await db.execute(sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations`),
  )
  const applied: AppliedMigrationRow[] = rows.map((row) => ({
    hash: String(row.hash),
    // bigint 列由驱动返回 **string**；NULL 必须保留成 null 而不是折叠成 0 —— drizzle 在 NULL 首行时
    // 读到的就是 `Number(null) = 0`，两者要能区分（判据见 `./journal-alignment`）。
    createdAt: row.created_at === null ? null : Number(row.created_at),
  }))
  const drift = findJournalDrift(entries, applied)
  if (drift.length === 0) return

  if (blockingDrift(drift).length > 0) {
    throw new Error(
      `迁移簿记与 journal 不对齐，已在跑 drizzle 之前停止\n${formatJournalDrift(drift, options)}`,
    )
  }
  console.warn(formatJournalDrift(drift, options))
}

/**
 * Drizzle's plain migrate command applies every SQL file at once. This wrapper runs
 * exactly the generated nullable schema phase first, then an idempotent Bun backfill,
 * and finally all remaining generated migrations. No generated file is modified.
 */
export async function migrateWithBackfill(databaseUrl: string): Promise<void> {
  const journal = (await Bun.file(join(folder, 'meta/_journal.json')).json()) as Journal
  const firstPhase = journal.entries.findIndex((entry) => entry.tag === FIRST_PHASE)
  const constraintPhase = journal.entries.findIndex((entry) => entry.tag === CONSTRAINT_PHASE)
  const governancePhase = journal.entries.findIndex((entry) => entry.tag === GOVERNANCE_PHASE)
  if (
    firstPhase < 0 ||
    constraintPhase !== firstPhase + 1 ||
    governancePhase !== constraintPhase + 1
  ) {
    throw new Error('缺少或顺序错误的 #217 分阶段生成迁移')
  }
  const staging = await mkdtemp(join(tmpdir(), 'fish-217-migrate-'))
  const db = createDb(databaseUrl)
  try {
    const legacy = await hasLegacyGovernance(db)
    // 守卫放在 legacy 判定**之后**：只有知道这是 #73 遗留库，才能把「生成阶段之前那些条目没有簿记行」
    // 讲成该路径的既有形状，而不是十几行假的「静默漏迁移」告警（那会把真正的漂移埋掉）。
    await assertJournalAlignment(db, await loadJournalEntryRefs(journal), {
      legacyPreMigrationWhen: legacy ? journal.entries[firstPhase]?.when : undefined,
    })
    await mkdir(join(staging, 'meta'))
    const throughConstraints = journal.entries.slice(0, constraintPhase + 1)
    // 复制而不是软链：Windows 上创建符号链接需要开发者模式或管理员权限，普通终端里
    // `symlink` 直接 EPERM（errno -4048），会让 `bun run db:migrate` 在 Windows 上完全跑不了。
    // drizzle 的 migrator 只读这些 .sql，复制一份行为等价。
    for (const entry of throughConstraints) {
      await copyFile(join(folder, `${entry.tag}.sql`), join(staging, `${entry.tag}.sql`))
    }
    await Bun.write(
      join(staging, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries: throughConstraints.slice(0, firstPhase + 1) }),
    )
    await migrate(db, { migrationsFolder: staging })
    await backfillIds(db)
    if (legacy) {
      await Bun.write(
        join(staging, 'meta/_journal.json'),
        JSON.stringify({ ...journal, entries: throughConstraints }),
      )
      await migrate(db, { migrationsFolder: staging })
      const governanceEntry = journal.entries[governancePhase]
      if (!governanceEntry) throw new Error('缺少治理迁移')
      await recognizeLegacyGovernance(db, governanceEntry)
    }
    await migrate(db, { migrationsFolder: folder })
    await rekeyLegacyIds(db)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('缺少 DATABASE_URL')
  await migrateWithBackfill(databaseUrl)
  console.log('[db] migration + ID backfill complete')
}
