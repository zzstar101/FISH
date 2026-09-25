import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { backfillIds } from './backfill-ids'
import { createDb } from './client'
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
    await mkdir(join(staging, 'meta'))
    const throughConstraints = journal.entries.slice(0, constraintPhase + 1)
    for (const entry of throughConstraints) {
      await symlink(join(folder, `${entry.tag}.sql`), join(staging, `${entry.tag}.sql`))
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
