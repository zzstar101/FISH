import { expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createDb } from './client'
import { conversations } from './schema/conversations'
import { jobs } from './schema/jobs'
import { listingImages, listings } from './schema/listings'
import { matches } from './schema/matches'
import { messages } from './schema/messages'
import { notifications } from './schema/notifications'
import { transactions } from './schema/transactions'
import { users } from './schema/users'
import { wishes } from './schema/wishes'
import { DEMO_PASSWORD, seed } from './seed'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

// 必须用 Bun.fileURLToPath：URL.pathname 在 Windows 上是 /C:/... 形式，migrator 读不到。
const migrationsFolder = Bun.fileURLToPath(new URL('./migrations', import.meta.url))

/**
 * seed 会 TRUNCATE 全部业务表，因此必须跑在**独立数据库**里：
 * 既不碰开发库，也不受其他测试文件顺序/并发方式的影响。
 * 顺带独立验证一次"migration 可在空库执行"。
 */
const scratchDatabase = `fish_seed_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

/** 只是拿它当"建/删库"的执行通道，所有断言都在 scratch 库上。 */
const admin = createDb(databaseUrl)

test('seed 可生成覆盖全部业务表的基础数据，且演示账号可用密码登录', async () => {
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  const scratch = createDb(scratchUrl)

  try {
    await migrate(scratch, { migrationsFolder })
    await scratch.transaction((tx) => seed(tx))

    const counts: Record<string, number> = {}
    for (const [name, table] of Object.entries({
      users,
      listings,
      listingImages,
      wishes,
      matches,
      conversations,
      messages,
      transactions,
      notifications,
      jobs,
    })) {
      counts[name] = await scratch.$count(table)
    }

    expect(counts).toEqual({
      users: 3,
      listings: 6,
      listingImages: 4,
      wishes: 2,
      matches: 1,
      conversations: 1,
      messages: 2,
      transactions: 2,
      notifications: 1,
      jobs: 1,
    })

    // seed 写的是真实 argon2id 哈希（#3 替换了 #2 的占位值），前端要用它登录调试，
    // 因此这里断言文档里的演示密码（README「演示账号」）确实能校验通过，而不只断言行数。
    const demoUsers = await scratch
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.studentNo, '202101000001'))
    const demoHash = demoUsers[0]?.passwordHash
    expect(demoHash).toBeDefined()
    expect(await Bun.password.verify(DEMO_PASSWORD, demoHash ?? '')).toBe(true)
    expect(await Bun.password.verify('wrong-password', demoHash ?? '')).toBe(false)

    // 回归：jsonb 列必须落成真正的 JSON object。
    // 用 `insert().values({ payload: {...} })` 写时 drizzle + bun-sql 会 stringify 两次，
    // 落库成为「JSON 字符串套 JSON」：drizzle 读回正常，但 `payload->>'x'` 在 SQL 层恒为 NULL，
    // #8 的 worker 只要按 payload 查就永远匹配不到。修复方式是 `jsonParam()`（见 src/json.ts）。
    const payloadRows = await scratch.execute<{ kind: string; ref: string | null }>(
      sql`select jsonb_typeof(payload) as kind, payload->>'listingId' as ref from jobs
          union all
          select jsonb_typeof(payload), payload->>'matchId' from notifications`,
    )
    expect([...payloadRows]).toHaveLength(2)
    for (const row of payloadRows) {
      expect(row.kind).toBe('object')
      expect(typeof row.ref).toBe('string')
    }
  } finally {
    await scratch.$client.close()
    await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  }
})
