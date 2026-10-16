import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq, inArray, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createDb, type Db } from './client'
import { newId } from './ids'
import { LISTING_VIEWS_WINDOW_DAYS, listingViewsCount } from './listing-views'
import { listings } from './schema/listings'
import { recommendationEvents } from './schema/recommendation-events'
import { users } from './schema/users'
import { reserveTestListingNo } from './testing/listing-no'

/**
 * 「浏览量」谓词的集成测试（#192）。
 *
 * 口径：**最近 30 天内浏览过该商品的去重人数**，来源是 `recommendation_events` 的
 * `DETAIL_VIEW`。这个谓词是全仓 10 条读路径共用的**唯一**实现，有五件事只有真库能证：
 *
 * 1. `::int` 不是装饰 —— `count(...)` 是 bigint，少了这个 cast，驱动交回来的不是 JS number；
 * 2. 子查询有没有真的按**当前行**的 listing 过滤。把限定列写丢（裸 `id` 会被解析成外层查询里
 *    同名的另一张表）会让每一条都恒为 0，而类型检查与打桩都看不出来；
 * 3. 身份去重语义：同一个人反复点开只算一次、登录后同一账号换会话仍算一次，
 *    且匿名会话 id 与 `user_id` 分属两个命名空间（客户端可以把会话 id 填成别人的 user_id）；
 * 4. 时间窗是**滚动 30 天**：窗口外的行必须消失（这是"数字会下降"的口径本身，不是 bug），
 *    且上界同样生效（入站允许 10 分钟时钟偏差，"未来"的行不能提前计入）；
 * 5. `event_type` 过滤：曝光/长读/收藏等其它事件类型不能混进"浏览"。
 *
 * 只断言"库里取出什么"，页面/契约层由各自的用例覆盖（`packages/contracts` 断言必填，
 * `apps/miniapp/tests/listing-adapt.test.ts` 断言端上原样透传）。
 *
 * 全部用例都按**真实调用形状**写：谓词是关联子查询，里面那个列引用由 drizzle 按查询上下文
 * 渲染 —— 多表查询（真实调用点大多是 `.from(...).innerJoin(...)`）渲染成 `"listings"."id"`；
 * 单表 / 裸 SQL 调用点必须传 `sql.raw('l.id')`（理由与踩坑记录见 `./listing-views.ts`）。
 */

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const migrationsFolder = Bun.fileURLToPath(new URL('./migrations', import.meta.url))
const scratchDatabase = `fish_listing_views_test_${process.pid}`
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
    'truncate table recommendation_events, listing_numbers, listings, users restart identity cascade',
  )
})

const DAY_MS = 24 * 60 * 60 * 1000
let seq = 0

async function createUser(): Promise<string> {
  const rows = await db
    .insert(users)
    .values({
      studentNo: `views-${Date.now()}-${seq++}`,
      passwordHash: 'test-not-a-real-hash',
      nickname: '浏览量测试用户',
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
    title: `浏览量测试商品 ${seq++}`,
    description: '只关心 recommendation_events 的计数口径。',
    priceCents: 100,
    category: 'OTHER',
    condition: 'GOOD',
  })
  return id
}

/** 一条行为事件。`identity` 二选一或都给（两列不互斥，见 schema 的表注释）。 */
async function addEvent(input: {
  listingId: string
  eventType?: 'DETAIL_VIEW' | 'LONG_VIEW' | 'IMPRESSION'
  userId?: string | null
  anonymousSessionId?: string | null
  occurredAt?: Date
}): Promise<void> {
  const eventType = input.eventType ?? 'DETAIL_VIEW'
  await db.insert(recommendationEvents).values({
    eventId: newId(),
    userId: input.userId ?? null,
    anonymousSessionId: input.anonymousSessionId ?? null,
    listingId: input.listingId,
    eventType,
    // 曝光类事件有「必须带归因」的库级 CHECK，构造一行合法的最小归因。
    requestId: eventType === 'IMPRESSION' ? newId() : null,
    position: eventType === 'IMPRESSION' ? 0 : null,
    occurredAt: input.occurredAt ?? new Date(),
  })
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}

describe('listingViewsCount', () => {
  test('数的是窗口内的去重人数：同人重复点开算 1、不同人各算 1、没人看过是 0，且不串到别的商品', async () => {
    const sellerId = await createUser()
    const viewerA = await createUser()
    const viewerB = await createUser()
    const busy = await createListing(sellerId)
    const single = await createListing(sellerId)
    const quiet = await createListing(sellerId)

    // 同一人点开三次：仍然是一个人
    await addEvent({ listingId: busy, userId: viewerA })
    await addEvent({ listingId: busy, userId: viewerA })
    await addEvent({ listingId: busy, userId: viewerA })
    await addEvent({ listingId: busy, userId: viewerB })
    await addEvent({ listingId: single, userId: viewerA })

    const rows = await db
      .select({ id: listings.id, views: listingViewsCount(listings.id) })
      .from(listings)
      .innerJoin(users, eq(users.id, listings.sellerId))
      .where(inArray(listings.id, [busy, single, quiet]))
    const views = new Map(rows.map((row) => [row.id, row.views]))

    expect(views.get(busy)).toBe(2)
    expect(views.get(single)).toBe(1)
    // 0 是事实（窗口内确实没有去重访客），不是"查不到"：三条都必须出现在结果里
    expect(views.get(quiet)).toBe(0)
    expect(rows).toHaveLength(3)
    for (const value of views.values()) expect(typeof value).toBe('number')
  })

  test('未登录按设备会话去重：同会话重复算 1、两个会话算 2', async () => {
    const sellerId = await createUser()
    const listing = await createListing(sellerId)
    const sessionA = newId()
    const sessionB = newId()

    await addEvent({ listingId: listing, anonymousSessionId: sessionA })
    await addEvent({ listingId: listing, anonymousSessionId: sessionA })
    await addEvent({ listingId: listing, anonymousSessionId: sessionB })

    const rows = await db
      .select({ views: listingViewsCount(listings.id) })
      .from(listings)
      .innerJoin(users, eq(users.id, listings.sellerId))
      .where(eq(listings.id, listing))

    expect(rows[0]?.views).toBe(2)
  })

  test('同一账号换会话仍算一个人（两列都有时按 user_id，不按会话重复计）', async () => {
    const sellerId = await createUser()
    const viewer = await createUser()
    const listing = await createListing(sellerId)

    await addEvent({ listingId: listing, userId: viewer, anonymousSessionId: newId() })
    await addEvent({ listingId: listing, userId: viewer, anonymousSessionId: newId() })
    // 两列都给的行与只给 user_id 的行是同一账号，合并成一个
    await addEvent({ listingId: listing, userId: viewer })

    const rows = await db
      .select({ views: listingViewsCount(listings.id) })
      .from(listings)
      .innerJoin(users, eq(users.id, listings.sellerId))
      .where(eq(listings.id, listing))

    expect(rows[0]?.views).toBe(1)
  })

  test('窗口有上界：时钟快出来的「未来」事件在它的时刻到来前不算数', async () => {
    const sellerId = await createUser()
    const viewerA = await createUser()
    const viewerB = await createUser()
    const listing = await createListing(sellerId)

    // 入站允许 MAX_CLOCK_SKEW_MS = 10 分钟的客户端时钟偏差，所以「未来」的行会真实落库。
    // 没有上界的话，一个可以把事件时刻写向未来的客户端就能立刻放大这个公开数字。
    await addEvent({
      listingId: listing,
      userId: viewerA,
      occurredAt: new Date(Date.now() + 5 * 60 * 1000),
    })
    await addEvent({
      listingId: listing,
      userId: viewerB,
      occurredAt: new Date(Date.now() - 60 * 1000),
    })

    const rows = await db
      .select({ views: listingViewsCount(listings.id) })
      .from(listings)
      .innerJoin(users, eq(users.id, listings.sellerId))
      .where(eq(listings.id, listing))

    expect(rows[0]?.views).toBe(1)
  })

  test('匿名身份与登录身份各有命名空间：匿名会话 id 冒充某个 user_id 不会并成一个人', async () => {
    const sellerId = await createUser()
    const viewer = await createUser()
    const listing = await createListing(sellerId)

    // 匿名会话 id 由客户端自选（契约只校验是 uuid），可以恰好等于某个真实用户的 id。
    // 不做命名空间分隔的话，这两行会去重成同一个值 → 少计一个人。
    await addEvent({ listingId: listing, userId: viewer })
    await addEvent({ listingId: listing, anonymousSessionId: viewer })

    const rows = await db
      .select({ views: listingViewsCount(listings.id) })
      .from(listings)
      .innerJoin(users, eq(users.id, listings.sellerId))
      .where(eq(listings.id, listing))

    expect(rows[0]?.views).toBe(2)
  })

  test('两列身份都空的事件归不到人：不计入（浏览 0 同时兼容"真没人看"与"有访客但都没身份"）', async () => {
    const sellerId = await createUser()
    const viewer = await createUser()
    const listing = await createListing(sellerId)

    // 未登录 + 从分享卡片/扫码直接进详情（推荐 Feed 从未挂载因而没有会话 id）就会上报这种行。
    // `count(DISTINCT NULL)` 是 0，所以它有事件、有曝光价值，但进不了"去重人数"。
    await addEvent({ listingId: listing })
    await addEvent({ listingId: listing, userId: viewer })

    const rows = await db
      .select({ views: listingViewsCount(listings.id) })
      .from(listings)
      .innerJoin(users, eq(users.id, listings.sellerId))
      .where(eq(listings.id, listing))

    expect(rows[0]?.views).toBe(1)
  })

  test(`滚动 ${LISTING_VIEWS_WINDOW_DAYS} 天：窗口内的算、窗口外的不算`, async () => {
    const sellerId = await createUser()
    const inside = await createUser()
    const outside = await createUser()
    const listing = await createListing(sellerId)

    await addEvent({
      listingId: listing,
      userId: inside,
      occurredAt: new Date(Date.now() - DAY_MS),
    })
    await addEvent({
      listingId: listing,
      userId: outside,
      occurredAt: new Date(Date.now() - (LISTING_VIEWS_WINDOW_DAYS + 1) * DAY_MS),
    })

    const rows = await db
      .select({ views: listingViewsCount(listings.id) })
      .from(listings)
      .innerJoin(users, eq(users.id, listings.sellerId))
      .where(eq(listings.id, listing))

    // 只有窗口内那一个人：旧浏览滚出窗口后数字下降是口径本身
    expect(rows[0]?.views).toBe(1)
  })

  test('只数 DETAIL_VIEW：曝光与长读不算浏览', async () => {
    const sellerId = await createUser()
    const viewer = await createUser()
    const listing = await createListing(sellerId)

    await addEvent({ listingId: listing, userId: viewer, eventType: 'IMPRESSION' })
    await addEvent({ listingId: listing, userId: viewer, eventType: 'LONG_VIEW' })

    const rows = await db
      .select({ views: listingViewsCount(listings.id) })
      .from(listings)
      .innerJoin(users, eq(users.id, listings.sellerId))
      .where(eq(listings.id, listing))

    expect(rows[0]?.views).toBe(0)

    await addEvent({ listingId: listing, userId: viewer, eventType: 'DETAIL_VIEW' })
    const after = await db
      .select({ views: listingViewsCount(listings.id) })
      .from(listings)
      .innerJoin(users, eq(users.id, listings.sellerId))
      .where(eq(listings.id, listing))

    expect(after[0]?.views).toBe(1)
  })

  test('裸 SQL 里用别名限定的列引用同样算得对（profile ownListings 走这条）', async () => {
    const sellerId = await createUser()
    const viewerA = await createUser()
    const viewerB = await createUser()
    const busy = await createListing(sellerId)
    const quiet = await createListing(sellerId)
    await addEvent({ listingId: busy, userId: viewerA })
    await addEvent({ listingId: busy, userId: viewerB })

    const result = await db.execute(sql`
      SELECT l.id AS id, ${listingViewsCount(sql.raw('l.id'))} AS views
      FROM listings l
      WHERE l.id IN (${busy}, ${quiet})
    `)
    const views = new Map(rowsOf(result).map((row) => [row.id as string, row.views]))

    expect(views.get(busy)).toBe(2)
    expect(views.get(quiet)).toBe(0)
    for (const value of views.values()) expect(typeof value).toBe('number')
  })
})
