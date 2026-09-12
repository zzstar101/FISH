import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb } from '@fish/db/client'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createSqlConversationStore } from './store'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../../../packages/db/src/migrations', import.meta.url),
)

/** 与 wishes store.test.ts 相同的 scratch 库模式：互不污染开发库。 */
const scratchDatabase = `fish_conversation_store_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const admin = createDb(databaseUrl)
const db = createDb(scratchUrl)
const store = createSqlConversationStore(db)

const buyer = '01990000-0000-7000-8000-0000000000a1'
const seller = '01990000-0000-7000-8000-0000000000a2'
const outsider = '01990000-0000-7000-8000-0000000000a3'
const listingA = '01990000-0000-7000-8000-0000000000b1'
const listingB = '01990000-0000-7000-8000-0000000000b2'

async function seedListing(listingId: string, sellerId: string, title: string) {
  await db.execute(sql`
    INSERT INTO listings (id, seller_id, title, description, price_cents, category, condition, status)
    VALUES (${listingId}, ${sellerId}, ${title}, '测试商品', 16000, 'DIGITAL', 'GOOD', 'ACTIVE')
  `)
}

beforeAll(async () => {
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  await migrate(db, { migrationsFolder })
  for (const [i, uid] of [buyer, seller, outsider].entries()) {
    await db.execute(sql`
      INSERT INTO users (id, student_no, password_hash, nickname)
      VALUES (${uid}, ${`conv${process.pid}_${i}`}, 'test-hash', '会话测试')
    `)
  }
  await seedListing(listingA, seller, 'K380 键盘')
  await seedListing(listingB, seller, '台灯')
})

afterAll(async () => {
  await db.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

describe('conversations store (integration)', () => {
  test('insertIfAbsent creates once and reuses via findIdByListingAndBuyer', async () => {
    const inserted = await store.insertIfAbsent(listingA, buyer, seller)
    if (!inserted) throw new Error('unreachable')
    const createdId = inserted.id

    // 并发创建：唯一索引 (listing_id, buyer_id) 保证只赢一个
    const results = await Promise.all([
      store.insertIfAbsent(listingA, buyer, seller),
      store.insertIfAbsent(listingA, buyer, seller),
      store.insertIfAbsent(listingA, buyer, seller),
    ])
    expect(results.every((row) => row === null)).toBe(true)
    expect(await store.findIdByListingAndBuyer(listingA, buyer)).toBe(createdId)
  })

  test('findDetail returns role data for participants and null for outsiders', async () => {
    const conversationId = await store.findIdByListingAndBuyer(listingA, buyer)
    if (!conversationId) throw new Error('unreachable')

    const buyerView = await store.findDetail(conversationId, buyer)
    expect(buyerView?.conversation.buyer_id).toBe(buyer)
    expect(buyerView?.listing.title).toBe('K380 键盘')
    expect(buyerView?.counterpart.id).toBe(seller)
    expect(buyerView?.unreadCount).toBe(0)

    expect(await store.findDetail(conversationId, outsider)).toBeNull()
  })

  test('unreadCount counts counterpart and SYSTEM messages after my last read', async () => {
    const conversationId = await store.findIdByListingAndBuyer(listingA, buyer)
    if (!conversationId) throw new Error('unreachable')

    await db.execute(sql`
      INSERT INTO messages (id, conversation_id, sender_id, type, content) VALUES
        (${crypto.randomUUID()}, ${conversationId}, ${seller}, 'TEXT', '在吗'),
        (${crypto.randomUUID()}, ${conversationId}, NULL, 'SYSTEM', '系统提示'),
        (${crypto.randomUUID()}, ${conversationId}, ${buyer}, 'TEXT', '我自己发的')
    `)

    const beforeRead = await store.findDetail(conversationId, buyer)
    expect(beforeRead?.unreadCount).toBe(2) // 对方 + SYSTEM；自己发的不算
    const sellerView = await store.findDetail(conversationId, seller)
    expect(sellerView?.unreadCount).toBe(2) // 买家的一条 + SYSTEM（SYSTEM 对双方都计未读）

    const afterRead = await store.markRead(conversationId, buyer)
    expect(afterRead?.unreadCount).toBe(0)
    // 卖家的未读不受买家标记影响（买家消息 + SYSTEM，共 2 条）
    expect((await store.findDetail(conversationId, seller))?.unreadCount).toBe(2)
  })

  test('markRead returns null for a non-participant', async () => {
    const conversationId = await store.findIdByListingAndBuyer(listingA, buyer)
    if (!conversationId) throw new Error('unreachable')
    expect(await store.markRead(conversationId, outsider)).toBeNull()
  })

  test('listForUser pages by (last_message_at, id) DESC with no gap or repeat on ties', async () => {
    // 两个会话同毫秒创建：last_message_at 相同到微秒，只能靠 id 决出顺序
    for (const listingId of [listingB, listingA]) {
      await store.insertIfAbsent(listingId, buyer, seller)
    }
    const conversationB = await store.findIdByListingAndBuyer(listingB, buyer)
    if (!conversationB) throw new Error('unreachable')
    // 给两个会话写消息，让 last_message_at 尽量接近；再把 A 的消息时间戳改成与 B 完全相同
    await db.execute(sql`
      UPDATE conversations SET last_message_at = '2026-09-12 10:00:00.123456+00'
      WHERE id IN (${conversationB}, (SELECT id FROM conversations WHERE listing_id = ${listingA} AND buyer_id = ${buyer}))
    `)

    const page1 = await store.listForUser(buyer, { limit: 1, cursor: null })
    expect(page1).toHaveLength(2) // limit+1 判底行
    // store 契约：返回 limit+1 行，service 丢弃多余行后用**保留页的最后一行**生成游标
    const kept = page1.slice(0, 1)
    const last = kept.at(-1)
    if (!last?.lastMessageAtCursor) throw new Error('unreachable')
    expect(last.lastMessageAtCursor).toBe('2026-09-12T10:00:00.123456Z')

    const page2 = await store.listForUser(buyer, {
      limit: 1,
      cursor: { sortKey: last.lastMessageAtCursor, id: last.conversation.id },
    })
    expect(page2).toHaveLength(1)
    // 翻页不重不漏：两页的 id 集合恰好是全部两个会话
    const ids = new Set([page1[0]?.conversation.id, page2[0]?.conversation.id])
    expect(ids.size).toBe(2)

    // 卖家视角同样能看到两个会话
    const sellerList = await store.listForUser(seller, { limit: 10, cursor: null })
    expect(sellerList).toHaveLength(2)
  })

  test('coverObjectKeys picks the lowest sort_order image per listing', async () => {
    await db.execute(sql`
      INSERT INTO listing_images (id, listing_id, object_key, sort_order) VALUES
        (${crypto.randomUUID()}, ${listingA}, 'covers/second.jpg', 1),
        (${crypto.randomUUID()}, ${listingA}, 'covers/first.jpg', 0)
    `)
    const covers = await store.coverObjectKeys([listingA, listingB])
    expect(covers.get(listingA)).toBe('covers/first.jpg')
    expect(covers.get(listingB)).toBeNull() // 无图商品 → null，不是缺失键
  })
})
