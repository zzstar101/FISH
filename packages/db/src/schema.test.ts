import { expect, test } from 'bun:test'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { createDb, type Db } from './client'
import { conversations } from './schema/conversations'
import { listings } from './schema/listings'
import { messages } from './schema/messages'
import { transactions } from './schema/transactions'
import { users } from './schema/users'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const db = createDb(databaseUrl)

type User = typeof users.$inferSelect
type Listing = typeof listings.$inferSelect

let seq = 0
const uniqueStudentNo = () => `t-${Date.now()}-${seq++}`

function required<T>(rows: T[], table: string): T {
  const row = rows[0]
  if (!row) throw new Error(`insert ${table} 未返回行`)
  return row
}

async function createUser(client: Db, studentNo: string): Promise<User> {
  const rows = await client
    .insert(users)
    .values({ studentNo, passwordHash: 'test-not-a-real-hash', nickname: studentNo })
    .returning()
  return required(rows, 'users')
}

async function createListing(client: Db, sellerId: string): Promise<Listing> {
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
  return required(rows, 'listings')
}

// 以下三个 helper 必须是 async：Bun 的 `expect(...).rejects` 不认 Drizzle 的 thenable query builder
async function createConversation(
  client: Db,
  listingId: string,
  buyerId: string,
  sellerId: string,
) {
  const rows = await client
    .insert(conversations)
    .values({ listingId, buyerId, sellerId })
    .returning()
  return required(rows, 'conversations')
}

async function createTransaction(client: Db, listingId: string, buyerId: string, sellerId: string) {
  const rows = await client
    .insert(transactions)
    .values({ listingId, buyerId, sellerId, amountCents: 100 })
    .returning()
  return required(rows, 'transactions')
}

async function createMessage(
  client: Db,
  conversationId: string,
  senderId: string | null,
  type: 'TEXT' | 'SYSTEM',
) {
  const rows = await client
    .insert(messages)
    .values({ conversationId, senderId, type, content: '集成测试' })
    .returning()
  return required(rows, 'messages')
}

/**
 * 每个用例自建、自清自己的数据。seed 用例不使用本 helper：它跑在独立数据库里
 * （见 seed.test.ts），因此不会 TRUNCATE 共享库。
 */
async function withFixture(
  run: (fixture: { seller: User; buyer: User; listing: Listing }) => Promise<void>,
) {
  const seller = await createUser(db, uniqueStudentNo())
  const buyer = await createUser(db, uniqueStudentNo())
  const listing = await createListing(db, seller.id)

  try {
    await run({ seller, buyer, listing })
  } finally {
    // messages 随 conversation CASCADE；conversations / transactions 的 listing 外键是 NO ACTION，故先删
    await db.delete(conversations).where(eq(conversations.listingId, listing.id))
    await db.delete(transactions).where(eq(transactions.listingId, listing.id))
    await db.delete(listings).where(eq(listings.id, listing.id))
    await db.delete(users).where(inArray(users.id, [seller.id, buyer.id]))
  }
}

test('同一 listing 最多一笔进行中/已成交交易，取消后可重新成交', async () => {
  await withFixture(async ({ seller, buyer, listing }) => {
    const first = await createTransaction(db, listing.id, buyer.id, seller.id)

    // 第二条进行中的交易必须被部分唯一索引拒绝
    await expect(createTransaction(db, listing.id, buyer.id, seller.id)).rejects.toThrow()

    // 第一笔取消后，listing 回到 ACTIVE，必须允许重新成交
    await db
      .update(transactions)
      .set({ status: 'CANCELLED', cancelledAt: new Date() })
      .where(eq(transactions.id, first.id))
    const second = await createTransaction(db, listing.id, buyer.id, seller.id)
    expect(second.id).not.toBe(first.id)
  })
})

test('并发接受交易时只有一个能占用 ACTIVE 商品', async () => {
  await withFixture(async ({ listing }) => {
    const otherConnection = createDb(databaseUrl)
    const claim = (client: Db) =>
      client
        .update(listings)
        .set({ status: 'RESERVED' })
        .where(and(eq(listings.id, listing.id), eq(listings.status, 'ACTIVE')))
        .returning({ id: listings.id })

    const results = await Promise.all([claim(db), claim(otherConnection)])
    expect(results.filter((rows) => rows.length === 1)).toHaveLength(1)
    expect(results.filter((rows) => rows.length === 0)).toHaveLength(1)
  })
})

test('会话与交易的 seller_id 必须等于商品所有者', async () => {
  await withFixture(async ({ seller, buyer, listing }) => {
    const stranger = await createUser(db, uniqueStudentNo())
    try {
      await expect(createConversation(db, listing.id, buyer.id, stranger.id)).rejects.toThrow()
      await expect(createTransaction(db, listing.id, buyer.id, stranger.id)).rejects.toThrow()

      // 正确的一对必须能写入
      const conversation = await createConversation(db, listing.id, buyer.id, seller.id)
      expect(conversation.sellerId).toBe(seller.id)
    } finally {
      await db.delete(users).where(eq(users.id, stranger.id))
    }
  })
})

test('TEXT 消息必须有发送者，SYSTEM 消息可以没有', async () => {
  await withFixture(async ({ seller, buyer, listing }) => {
    const conversation = await createConversation(db, listing.id, buyer.id, seller.id)

    await expect(createMessage(db, conversation.id, null, 'TEXT')).rejects.toThrow()

    const text = await createMessage(db, conversation.id, buyer.id, 'TEXT')
    expect(text.senderId).toBe(buyer.id)
    const system = await createMessage(db, conversation.id, null, 'SYSTEM')
    expect(system.senderId).toBeNull()
  })
})

test('不存在 Offer 表', async () => {
  const rows = await db.execute<{ table_name: string }>(
    sql`select table_name from information_schema.tables where table_schema = 'public' and table_name ilike '%offer%'`,
  )
  expect(rows.map((row) => row.table_name)).toEqual([])
})
