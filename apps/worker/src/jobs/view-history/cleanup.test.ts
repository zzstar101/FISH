import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { VIEW_HISTORY_RETENTION_MS } from '@fish/contracts/view-history/schema'
import { createDb } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { listings } from '@fish/db/schema/listings'
import { listingViewHistory } from '@fish/db/schema/view-history'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { and, eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { cleanupExpiredViewHistory } from './cleanup'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../../../packages/db/src/migrations', import.meta.url),
)

/** scratch 库模式（与 API 侧 store 测试一致）：清理是全表条件删，隔离库才能断言精确行数。 */
const scratchDatabase = `fish_view_history_cleanup_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const admin = createDb(databaseUrl)
const db = createDb(scratchUrl)

const NOW = new Date('2026-10-02T00:00:00.000000Z')
const insideWindow = new Date(NOW.getTime() - VIEW_HISTORY_RETENTION_MS + 60_000)
const outsideWindow = new Date(NOW.getTime() - VIEW_HISTORY_RETENTION_MS - 60_000)

const user = '01990000-0000-7000-8000-0000000000c1'
const seller = '01990000-0000-7000-8000-0000000000c2'
const listingIds: string[] = []

beforeAll(async () => {
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  await migrate(db, { migrationsFolder })

  for (const [i, uid] of [user, seller].entries()) {
    await db.execute(sql`
      INSERT INTO users (id, student_no, password_hash, nickname)
      VALUES (${uid}, ${`vhclean${process.pid}_${i}`}, 'test-hash', '清理测试')
    `)
  }
  for (let i = 0; i < 4; i += 1) {
    const id = newId()
    listingIds.push(id)
    await db.insert(listings).values({
      id,
      listingNo: await reserveTestListingNo(db, id),
      sellerId: seller,
      title: `清理测试商品 ${i}`,
      description: '描述',
      priceCents: 100,
      category: 'OTHER',
      condition: 'GOOD',
    })
  }
})

afterAll(async () => {
  await db.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

describe('cleanupExpiredViewHistory', () => {
  test('只删窗口外的行，窗口内的保留；limit 分批下轮继续', async () => {
    await db.insert(listingViewHistory).values([
      // 3 条过期 + 1 条窗口内（第 4 件商品故意不建足迹，留作对照）。
      { userId: user, listingId: listingIds[0] as string, lastViewedAt: outsideWindow },
      { userId: user, listingId: listingIds[1] as string, lastViewedAt: outsideWindow },
      { userId: user, listingId: listingIds[2] as string, lastViewedAt: outsideWindow },
      { userId: user, listingId: listingIds[3] as string, lastViewedAt: insideWindow },
    ])

    // 一轮只删 2 条：清理是后台杂务，不扫全表。
    const first = await cleanupExpiredViewHistory({ db, now: NOW, limit: 2 })
    expect(first).toEqual({ scanned: 2, deleted: 2 })

    // 窗口内的行一条都不能少。
    const kept = await db
      .select({ id: listingViewHistory.id })
      .from(listingViewHistory)
      .where(
        and(
          eq(listingViewHistory.userId, user),
          eq(listingViewHistory.listingId, listingIds[3] as string),
        ),
      )
    expect(kept).toHaveLength(1)

    // 下一轮捡起剩下的 1 条。
    const second = await cleanupExpiredViewHistory({ db, now: NOW, limit: 2 })
    expect(second).toEqual({ scanned: 1, deleted: 1 })

    const total = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(listingViewHistory)
      .where(eq(listingViewHistory.userId, user))
    expect(Number(total[0]?.count)).toBe(1)
  })
})
