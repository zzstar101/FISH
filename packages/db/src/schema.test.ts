import { expect, test } from 'bun:test'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { createDb, type Db } from './client'
import { listings } from './schema/listings'
import { transactions } from './schema/transactions'
import { users } from './schema/users'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const db = createDb(databaseUrl)

let seq = 0
const uniqueStudentNo = () => `t-${Date.now()}-${seq++}`

async function createUser(client: Db, studentNo: string) {
  const rows = await client
    .insert(users)
    .values({ studentNo, passwordHash: 'test-not-a-real-hash', nickname: studentNo })
    .returning()
  const row = rows[0]
  if (!row) throw new Error('insert users 未返回行')
  return row
}

async function createListing(client: Db, sellerId: string) {
  const rows = await client
    .insert(listings)
    .values({
      sellerId,
      title: '集成测试商品',
      description: '集成测试',
      priceCents: 100,
      category: 'OTHER',
      condition: 'GOOD',
    })
    .returning()
  const row = rows[0]
  if (!row) throw new Error('insert listings 未返回行')
  return row
}

// 必须是 async：Bun 的 `expect(...).rejects` 不认 Drizzle 的 thenable query builder
async function insertPendingTransaction(
  client: Db,
  listingId: string,
  buyerId: string,
  sellerId: string,
) {
  return client
    .insert(transactions)
    .values({ listingId, buyerId, sellerId, amountCents: 100 })
    .returning()
}

test('同一 listing 最多一笔进行中/已成交交易，取消后可重新成交', async () => {
  const seller = await createUser(db, uniqueStudentNo())
  const buyer = await createUser(db, uniqueStudentNo())
  const listing = await createListing(db, seller.id)
  const args = [listing.id, buyer.id, seller.id] as const

  try {
    const first = (await insertPendingTransaction(db, ...args))[0]
    if (!first) throw new Error('insert transactions 未返回行')

    // 第二条进行中的交易必须被部分唯一索引拒绝
    await expect(insertPendingTransaction(db, ...args)).rejects.toThrow()

    // 第一笔取消后，listing 回到 ACTIVE，必须允许重新成交
    await db
      .update(transactions)
      .set({ status: 'CANCELLED', cancelledAt: new Date() })
      .where(eq(transactions.id, first.id))
    const second = (await insertPendingTransaction(db, ...args))[0]
    expect(second?.id).not.toBe(first.id)
  } finally {
    await db.delete(transactions).where(eq(transactions.listingId, listing.id))
    await db.delete(listings).where(eq(listings.id, listing.id))
    await db.delete(users).where(inArray(users.id, [seller.id, buyer.id]))
  }
})

test('并发接受交易时只有一个能占用 ACTIVE 商品', async () => {
  const seller = await createUser(db, uniqueStudentNo())
  const listing = await createListing(db, seller.id)
  const otherConnection = createDb(databaseUrl)

  const claim = (client: Db) =>
    client
      .update(listings)
      .set({ status: 'RESERVED' })
      .where(and(eq(listings.id, listing.id), eq(listings.status, 'ACTIVE')))
      .returning({ id: listings.id })

  try {
    const results = await Promise.all([claim(db), claim(otherConnection)])
    expect(results.filter((rows) => rows.length === 1)).toHaveLength(1)
    expect(results.filter((rows) => rows.length === 0)).toHaveLength(1)
  } finally {
    await db.delete(listings).where(eq(listings.id, listing.id))
    await db.delete(users).where(eq(users.id, seller.id))
  }
})

test('不存在 Offer 表', async () => {
  const rows = await db.execute<{ table_name: string }>(
    sql`select table_name from information_schema.tables where table_schema = 'public' and table_name ilike '%offer%'`,
  )
  expect(rows.map((row) => row.table_name)).toEqual([])
})
