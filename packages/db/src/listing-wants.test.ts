import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq, inArray, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createDb, type Db } from './client'
import { newId } from './ids'
import { listingWantsCount } from './listing-wants'
import { conversations } from './schema/conversations'
import { listings } from './schema/listings'
import { users } from './schema/users'
import { reserveTestListingNo } from './testing/listing-no'

/**
 * 「想要数」谓词的集成测试（#74 / #406 第 5 项）。
 *
 * 这个谓词是全仓 10 条读路径（feed / 搜索 / 匹配 / 他人主页 / 我的发布 …）共用的**唯一**实现，
 * 有两件事只有真库能证：
 * 1. `::int` 不是装饰——`count(*)` 是 bigint，少了这个 cast，驱动交回来的就不是 JS number，
 *    而调用方（`apps/api/src/modules/profile/store.ts:168` 等）是在映射层才 `Number()` 的；
 * 2. 子查询有没有真的按**当前行**的 listing 过滤。把限定列写丢（裸 `id` 会被解析成外层查询
 *    里同名的另一张表）会让每一条都恒为 0，而类型检查与打桩都看不出来。
 *
 * 只断言"库里取出什么"，页面/契约层由各自的用例覆盖。
 *
 * 两个用例都按**真实调用形状**写：谓词是关联子查询，里面那个列引用由 drizzle 按查询上下文
 * 渲染 —— 多表查询（真实调用点全是 `.from(...).innerJoin(...)`）渲染成 `"listings"."id"`，
 * 正确；单表 `.from(listings)` 渲染成裸 `"id"`，在子查询作用域里会解析到 `conversations.id`
 * （条件恒假）静默得 0。单表调用点必须改传 `sql.raw('l.id')`，已记在
 * `packages/db/src/listing-wants.ts` 的注释里。
 */

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const migrationsFolder = Bun.fileURLToPath(new URL('./migrations', import.meta.url))
const scratchDatabase = `fish_listing_wants_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const admin = createDb(databaseUrl)
let db: Db

beforeAll(async () => {
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  db = createDb(scratchUrl)
  await migrate(db, { migrationsFolder })
})

afterAll(async () => {
  await db.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

// 断言按商品逐个比对，不能容忍上一个用例残留的行。
beforeEach(async () => {
  await db.$client.unsafe(
    'truncate table conversations, listing_numbers, listings, users restart identity cascade',
  )
})

let seq = 0

async function createUser(): Promise<string> {
  const rows = await db
    .insert(users)
    .values({
      studentNo: `wants-${Date.now()}-${seq++}`,
      passwordHash: 'test-not-a-real-hash',
      nickname: '想要数测试用户',
    })
    .returning({ id: users.id })
  const row = rows[0]
  if (!row) throw new Error('insert users 未返回行')
  return row.id
}

async function createListing(sellerId: string): Promise<string> {
  const id = newId()
  await db.insert(listings).values({
    id,
    listingNo: await reserveTestListingNo(db, id),
    sellerId,
    title: `想要数测试商品 ${seq++}`,
    description: '只关心 conversations 的计数口径。',
    priceCents: 100,
    category: 'OTHER',
    condition: 'GOOD',
  })
  return id
}

/** 「想要」= 与该商品已建会话的买家，一条会话算一个买家（唯一约束保证不会重复）。 */
async function addWatcher(listingId: string, sellerId: string, buyerId: string): Promise<void> {
  await db.insert(conversations).values({ id: newId(), listingId, buyerId, sellerId })
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}

describe('listingWantsCount', () => {
  test('数的是该商品的会话买家：两人两条是 2、一人一条是 1、没人开过会话是 0，且不串到别的商品', async () => {
    const sellerId = await createUser()
    const buyerA = await createUser()
    const buyerB = await createUser()
    const busy = await createListing(sellerId)
    const single = await createListing(sellerId)
    const quiet = await createListing(sellerId)
    await addWatcher(busy, sellerId, buyerA)
    await addWatcher(busy, sellerId, buyerB)
    await addWatcher(single, sellerId, buyerA)

    const rows = await db
      .select({ id: listings.id, wants: listingWantsCount(listings.id) })
      .from(listings)
      .innerJoin(users, eq(users.id, listings.sellerId))
      .where(inArray(listings.id, [busy, single, quiet]))
    const wants = new Map(rows.map((row) => [row.id, row.wants]))

    expect(wants.get(busy)).toBe(2)
    expect(wants.get(single)).toBe(1)
    // 0 是事实（确实还没人开过会话），不是"查不到"：三条都必须出现在结果里
    expect(wants.get(quiet)).toBe(0)
    expect(rows).toHaveLength(3)
    for (const value of wants.values()) expect(typeof value).toBe('number')
  })

  test('裸 SQL 里用别名限定的列引用同样算得对（profile ownListings 走这条）', async () => {
    const sellerId = await createUser()
    const buyerA = await createUser()
    const buyerB = await createUser()
    const busy = await createListing(sellerId)
    const quiet = await createListing(sellerId)
    await addWatcher(busy, sellerId, buyerA)
    await addWatcher(busy, sellerId, buyerB)

    const result = await db.execute(sql`
      SELECT l.id AS id, ${listingWantsCount(sql.raw('l.id'))} AS wants
      FROM listings l
      WHERE l.id IN (${busy}, ${quiet})
    `)
    const wants = new Map(rowsOf(result).map((row) => [row.id as string, row.wants]))

    expect(wants.get(busy)).toBe(2)
    expect(wants.get(quiet)).toBe(0)
    for (const value of wants.values()) expect(typeof value).toBe('number')
  })
})
