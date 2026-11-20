import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb } from '@fish/db/client'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createSqlRateLimitStore } from './store'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../../../packages/db/src/migrations', import.meta.url),
)
const scratchDatabase = `fish_rate_limit_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const admin = createDb(databaseUrl)
const db = createDb(scratchUrl)
const store = createSqlRateLimitStore(db)

beforeAll(async () => {
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  await migrate(db, { migrationsFolder })
})

afterAll(async () => {
  await db.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

describe('rate limit store（#694 M3）', () => {
  test('窗口内达到上限即拒绝，返回可倒计时的 retryAfterSeconds', async () => {
    const entry = { bucket: 'test:limit', subject: 'user-a', limit: 2, windowSeconds: 60 }
    expect(await store.takeAll([entry])).toEqual({ allowed: true })
    expect(await store.takeAll([entry])).toEqual({ allowed: true })
    const denied = await store.takeAll([entry])
    expect(denied.allowed).toBe(false)
    if (!denied.allowed) {
      expect(denied.bucket).toBe('test:limit')
      expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1)
      expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60)
    }
  })

  test('多个桶原子判定：任一超限时另一个桶也不写行', async () => {
    const full = { bucket: 'test:full', subject: 'user-b', limit: 1, windowSeconds: 60 }
    const fresh = { bucket: 'test:fresh', subject: 'user-b', limit: 5, windowSeconds: 60 }
    expect(await store.takeAll([full])).toEqual({ allowed: true })
    const denied = await store.takeAll([fresh, full])
    expect(denied.allowed).toBe(false)
    // fresh 桶被拒时不应留下事件：后续单独请求仍可完整使用 5 次额度。
    for (let i = 0; i < 5; i++) expect(await store.takeAll([fresh])).toEqual({ allowed: true })
  })

  test('窗口外的旧事件被清理，不会永久占用额度', async () => {
    const entry = { bucket: 'test:window', subject: 'user-c', limit: 1, windowSeconds: 60 }
    expect(await store.takeAll([entry])).toEqual({ allowed: true })
    expect((await store.takeAll([entry])).allowed).toBe(false)
    await db.execute(sql`
      UPDATE rate_limit_events
      SET created_at = now() - interval '2 minutes'
      WHERE bucket = 'test:window' AND subject = 'user-c'
    `)
    expect(await store.takeAll([entry])).toEqual({ allowed: true })
  })
})
