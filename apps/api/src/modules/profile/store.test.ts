import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb } from '@fish/db/client'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createSqlProfileStore } from './store'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../../../packages/db/src/migrations', import.meta.url),
)

/** 与 wishes store.test.ts 相同的 scratch 库模式：互不污染开发库。 */
const scratchDatabase = `fish_profile_store_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const admin = createDb(databaseUrl)
const db = createDb(scratchUrl)
const store = createSqlProfileStore(db)

const me = '01990000-0000-7000-8000-0000000000a1'
const other = '01990000-0000-7000-8000-0000000000a2'
const listingA = '01990000-0000-7000-8000-0000000000b1'
const listingB = '01990000-0000-7000-8000-0000000000b2'
const wishA = '01990000-0000-7000-8000-0000000000d1'
const txA = '01990000-0000-7000-8000-0000000000e1' // 我是买家
const txB = '01990000-0000-7000-8000-0000000000e2' // 我是卖家

beforeAll(async () => {
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  await migrate(db, { migrationsFolder })
  for (const [i, uid] of [me, other].entries()) {
    await db.execute(sql`
      INSERT INTO users (id, student_no, password_hash, nickname)
      VALUES (${uid}, ${`prof${process.pid}_${i}`}, 'test-hash', '个人中心测试')
    `)
  }
  for (const [listingId, status] of [
    [listingA, 'ACTIVE'],
    [listingB, 'OFFLINE'], // 本人可见，但不算在售统计
  ] as const) {
    await db.execute(sql`
      INSERT INTO listings (id, seller_id, title, description, price_cents, category, condition, status)
      VALUES (${listingId}, ${me}, '商品', '描述', 16000, 'DIGITAL', 'GOOD', ${status})
    `)
  }
  await db.execute(sql`
    INSERT INTO wishes (id, user_id, keyword, category, budget_min_cents, budget_max_cents, status)
    VALUES (${wishA}, ${me}, '机械键盘', 'DIGITAL', 10000, 20000, 'ACTIVE')
  `)
  // 封面只认 sort_order = 0（#6 契约 §1）：listingA 有 0 号图（并额外给一张 9 号图，
  // 证明取的是 0 而不是"序号最大的"），listingB 只有 2 号图 → 只能判 null，不能顶替。
  await db.execute(sql`
    INSERT INTO listing_images (id, listing_id, object_key, sort_order) VALUES
      ('01990000-0000-7000-8000-0000000000c1', ${listingA}, 'listings/a/0.jpg', 0),
      ('01990000-0000-7000-8000-0000000000c2', ${listingA}, 'listings/a/9.jpg', 9),
      ('01990000-0000-7000-8000-0000000000c3', ${listingB}, 'listings/b/2.jpg', 2)
  `)
  // other 的商品，供"我的交易"用：txA 我买，txB 我卖
  await db.execute(sql`
    INSERT INTO listings (id, seller_id, title, description, price_cents, category, condition, status)
    VALUES ('01990000-0000-7000-8000-0000000000b3', ${other}, '对方商品', '描述', 10000, 'DAILY', 'GOOD', 'SOLD')
  `)
  await db.execute(sql`
    INSERT INTO transactions (id, listing_id, buyer_id, seller_id, amount_cents, status, completed_at)
    VALUES
      (${txA}, '01990000-0000-7000-8000-0000000000b3', ${me}, ${other}, 10000, 'COMPLETED', now()),
      (${txB}, ${listingA}, ${other}, ${me}, 16000, 'PENDING_MEETUP', NULL)
  `)
})

afterAll(async () => {
  await db.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

describe('profile store (integration)', () => {
  test('stats counts only ACTIVE listings/wishes and COMPLETED transactions (两角色合并)', async () => {
    const stats = await store.stats(me)
    expect(stats).toEqual({
      activeListings: 1, // listingA ACTIVE；listingB OFFLINE 不计
      activeWishes: 1,
      completedTransactions: 1, // txA COMPLETED；txB PENDING 不计
    })
  })

  test('ownListings returns own listings in any status, newest first, with cover', async () => {
    const rows = await store.ownListings(me, 100)
    expect(rows).toHaveLength(2)
    expect(rows[0]?.status).toBe('OFFLINE') // listingB 后插 → 时间倒序在前
    // listingB 只有 2 号图 → 封面判 null；listingA 有 0 号图 → 取 0 号（不是序号最大的那张）
    expect(rows[0]?.coverObjectKey).toBeNull()
    expect(rows[1]?.coverObjectKey).toBe('listings/a/0.jpg')
  })

  test('ownListings does not include other users listings (只返回本人可见数据)', async () => {
    const rows = await store.ownListings(other, 100)
    expect(rows.map((row) => row.id)).toEqual(['01990000-0000-7000-8000-0000000000b3'])
  })

  test('ownWishes returns own wishes with matchCount', async () => {
    const rows = await store.ownWishes(me, 100)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.match_count).toBe(0)
  })

  test('a NULL-budget wish (seed 形状) is excluded rather than crashing the aggregate', async () => {
    // 与 seed 的 wishKeyboard 同形状：category 非空、budget 为 NULL（#2 为 #8 预留）
    await db.execute(sql`
      INSERT INTO wishes (id, user_id, keyword, category, budget_min_cents, budget_max_cents, status)
      VALUES ('01990000-0000-7000-8000-0000000000d2', ${me}, '键盘', 'DIGITAL', NULL, NULL, 'ACTIVE')
    `)
    const rows = await store.ownWishes(me, 100)
    // NULL budget 行被过滤（契约 WishDto 三字段皆非空），其余愿望照常返回
    expect(rows.map((row) => row.id)).toEqual([wishA])
  })

  test('stats().activeWishes 与 ownWishes 可见列表口径一致（NULL 预算愿望不计入统计）', async () => {
    // 上一条用例插入了 ACTIVE 但 budget 全 NULL 的愿望：它进不了列表（契约 WishDto 要求非空），
    // 也就不能进统计——否则个人中心会显示「愿望 2」而列表只有 1 条。
    const stats = await store.stats(me)
    const rows = await store.ownWishes(me, 100)
    expect(stats.activeWishes).toBe(rows.length)
    expect(stats.activeWishes).toBe(1)
  })

  test('ownTransactions merges buying and selling; buyer_id distinguishes the role', async () => {
    const rows = await store.ownTransactions(me, 100)
    expect(rows).toHaveLength(2)
    const byId = new Map(rows.map((row) => [row.id, row]))
    expect(byId.get(txA)?.buyerId).toBe(me) // 我买
    expect(byId.get(txB)?.buyerId).toBe(other) // 我卖
    // 内嵌摘要：商品 join 必中（FK）；counterpart 按查看者视角解析
    const txARow = byId.get(txA)
    expect(txARow?.listing).toMatchObject({ title: expect.any(String) })
    expect(txARow?.counterpart?.id).toBe(other) // 我买 → 对方是卖家 other
    expect(byId.get(txB)?.counterpart?.id).toBe(other) // 我卖 → 对方是买家 other
  })

  test('limit caps each list', async () => {
    expect(await store.ownListings(me, 1)).toHaveLength(1)
    expect(await store.ownTransactions(me, 1)).toHaveLength(1)
  })

  test('交易摘要的封面只认 sort_order = 0，缺 0 号图时返回 null 而不顶替', async () => {
    // 脏数据形状：商品只有 sort_order = 1 的图片、没有 0 号（#6 契约 §1：0 才是封面）。
    // 放在最后一个用例：它的插入不干扰前面那些列表/统计条数的断言。
    await db.execute(sql`
      INSERT INTO listings (id, seller_id, title, description, price_cents, category, condition, status)
      VALUES ('01990000-0000-7000-8000-0000000000b4', ${other}, '无封面商品', '描述', 10000, 'DAILY', 'GOOD', 'SOLD')
    `)
    await db.execute(sql`
      INSERT INTO listing_images (id, listing_id, object_key, sort_order)
      VALUES ('01990000-0000-7000-8000-0000000000f1', '01990000-0000-7000-8000-0000000000b4', 'listings/b4/1.jpg', 1)
    `)
    await db.execute(sql`
      INSERT INTO transactions (id, listing_id, buyer_id, seller_id, amount_cents, status, completed_at)
      VALUES ('01990000-0000-7000-8000-0000000000e3', '01990000-0000-7000-8000-0000000000b4', ${me}, ${other}, 10000, 'COMPLETED', now())
    `)

    const rows = await store.ownTransactions(me, 100)
    const row = rows.find((item) => item.id === '01990000-0000-7000-8000-0000000000e3')
    expect(row?.listing?.coverObjectKey).toBeNull()
  })
})
