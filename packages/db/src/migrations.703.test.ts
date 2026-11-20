import { expect, test } from 'bun:test'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createDb } from './client'

/**
 * #703 迁移的存量库行为：带学号/密码列的老数据 → 跑 #703 迁移 → 旧列消失、uid 回填且唯一。
 *
 * 与 `migrations.217.test.ts` 同一手法：自建 scratch 库，先把 journal 裁到迁移前（idx ≤ 50），
 * 用当时的历史 schema 灌数据，再用真实 journal 跑剩余迁移。
 */
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('迁移集成测试需要 DATABASE_URL')
const folder = join(import.meta.dir, 'migrations')

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && 'rows' in result && Array.isArray(result.rows)) {
    return result.rows as Record<string, unknown>[]
  }
  return []
}

const UID_PATTERN = /^[1-9]\d{9}$/

test('#703 存量用户回填 10 位 UID，旧列删除，格式约束拒绝前导 0', async () => {
  const admin = createDb(databaseUrl)
  const databaseName = `fish_703_migration_${process.pid}`
  const url = new URL(databaseUrl)
  url.pathname = `/${databaseName}`
  const scratchUrl = url.toString()
  const staging = await mkdtemp(join(tmpdir(), 'fish-703-old-schema-'))
  let scratch: ReturnType<typeof createDb> | undefined
  try {
    await admin.$client.unsafe(`CREATE DATABASE "${databaseName}"`)
    scratch = createDb(scratchUrl)
    await mkdir(join(staging, 'meta'))
    const journal = (await Bun.file(join(folder, 'meta/_journal.json')).json()) as {
      entries: { idx: number; tag: string }[]
    }
    const entries = journal.entries.filter((entry) => entry.idx <= 50)
    await Bun.write(join(staging, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }))
    for (const entry of entries) {
      await copyFile(join(folder, `${entry.tag}.sql`), join(staging, `${entry.tag}.sql`))
    }
    await migrate(scratch, { migrationsFolder: staging })

    // 旧 schema 下的三个用户：有学号、有密码哈希，uid 列还不存在。
    const legacyIds = [
      '01930000-0000-7000-8000-0000000000c1',
      '01930000-0000-7000-8000-0000000000c2',
      '01930000-0000-7000-8000-0000000000c3',
    ]
    for (const [index, id] of legacyIds.entries()) {
      await scratch.execute(sql`INSERT INTO users (id, student_no, password_hash, nickname)
        VALUES (${id}::uuid, ${`703-legacy-${index}`}, 'test-hash', ${`迁移用户${index}`})`)
    }

    // 用真实 journal 续跑：只应剩 #703 一条未应用。
    await migrate(scratch, { migrationsFolder: folder })

    const columns = rowsOf(
      await scratch.execute(sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'users' AND column_name IN ('student_no', 'password_hash', 'uid')
        ORDER BY column_name
      `),
    ).map((row) => String(row.column_name))
    expect(columns).toEqual(['uid'])

    const uids = rowsOf(
      await scratch.execute(sql`
        SELECT id, uid FROM users WHERE id IN (
          ${legacyIds[0]}::uuid, ${legacyIds[1]}::uuid, ${legacyIds[2]}::uuid
        )
      `),
    )
    expect(uids).toHaveLength(3)
    const values = uids.map((row) => String(row.uid))
    for (const value of values) expect(value).toMatch(UID_PATTERN)
    expect(new Set(values).size).toBe(3)

    // 迁移后应用插入不传 uid：DB 默认值仍按行生成。
    const [created] = rowsOf(
      await scratch.execute(sql`INSERT INTO users (nickname) VALUES ('新用户') RETURNING uid`),
    )
    expect(String(created?.uid)).toMatch(UID_PATTERN)
    expect(values).not.toContain(String(created?.uid))

    // CHECK 与契约同口径：10 位、首位非 0。
    const rejected = await scratch
      .execute(sql`UPDATE users SET uid = '0123456789' WHERE id = ${legacyIds[0]}::uuid`)
      .then(() => false)
      .catch(() => true)
    expect(rejected).toBe(true)
  } finally {
    if (scratch) await scratch.$client.close()
    await admin.$client.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
    await admin.$client.close()
    await rm(staging, { recursive: true, force: true })
  }
})
