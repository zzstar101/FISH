import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb, type Db } from '@fish/db/client'
import { syncLegacyMediaInventory } from '@fish/db/legacy-media-audit'
import { listingImages, listings } from '@fish/db/schema/listings'
import { users } from '@fish/db/schema/users'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { enqueueLegacyMediaAuditBatch } from './enqueue'

/**
 * `LEGACY_MEDIA_AUDIT` 的 enqueue 幂等（#694 审查 P1-4）。
 *
 * 去重靠部分唯一索引 `(payload->>'objectKey') WHERE status='PENDING'`；只有 payload 是
 * 真 jsonb 对象时 `->>` 才取得到键。裸对象经 drizzle + bun-sql 会落成 jsonb **字符串**，
 * 本用例就是为了把那次实测过的回归钉住。
 */
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const scratchDatabase = `fish_legacy_media_enqueue_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()
const migrationsFolder = new URL('../../../../../packages/db/src/migrations', import.meta.url)
  .pathname

const adminDb = createDb(databaseUrl)
let db: Db

const SELLER_ID = '01930000-0000-4000-8000-000000000801'
const LISTING_ID = '01930000-0000-4000-8000-000000000802'
const OBJECT_KEY = 'listings/01930000-0000-4000-8000-0000000008a1/pending.png'

beforeAll(async () => {
  await adminDb.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await adminDb.$client.unsafe(`create database "${scratchDatabase}"`)
  db = createDb(scratchUrl)
  await migrate(db, { migrationsFolder })

  await db.insert(users).values({ id: SELLER_ID, nickname: '卖家' })
  const listingNo = await reserveTestListingNo(db, LISTING_ID)
  await db.insert(listings).values({
    id: LISTING_ID,
    listingNo,
    sellerId: SELLER_ID,
    title: '商品',
    description: '描述',
    priceCents: 100,
    category: 'OTHER',
    condition: 'GOOD',
  })
  await db
    .insert(listingImages)
    .values({ listingId: LISTING_ID, objectKey: OBJECT_KEY, sortOrder: 0 })
  await syncLegacyMediaInventory(db)
})

afterAll(async () => {
  if (db) await db.$client.close()
  await adminDb.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await adminDb.$client.close()
})

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}

describe('legacy media audit enqueue', () => {
  test('连续两次入队只产生一条 PENDING job，payload 是真 jsonb 对象', async () => {
    const first = await enqueueLegacyMediaAuditBatch(db, { limit: 10, maxAttempts: 3 })
    expect(first.enqueued).toBe(1)

    const second = await enqueueLegacyMediaAuditBatch(db, { limit: 10, maxAttempts: 3 })
    expect(second.enqueued).toBe(0)

    const rows = rowsOf(
      await db.execute(sql`
        SELECT payload->>'objectKey' AS object_key, jsonb_typeof(payload) AS payload_type
        FROM jobs
        WHERE type = 'LEGACY_MEDIA_AUDIT'
      `),
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]?.object_key).toBe(OBJECT_KEY)
    expect(rows[0]?.payload_type).toBe('object')
  })
})
