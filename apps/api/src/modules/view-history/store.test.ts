import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb } from '@fish/db/client'
import { listings } from '@fish/db/schema/listings'
import { listingViewHistory } from '@fish/db/schema/view-history'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { and, eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { recordViewHistoryWith } from './ingest'
import { createSqlViewHistoryStore } from './store'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../../../packages/db/src/migrations', import.meta.url),
)

/** 与 favorites / profile 的 store 测试相同的 scratch 库模式：互不污染开发库。 */
const scratchDatabase = `fish_view_history_store_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const admin = createDb(databaseUrl)
const db = createDb(scratchUrl)
const store = createSqlViewHistoryStore(db)

const me = '01990000-0000-7000-8000-0000000000a1'
const other = '01990000-0000-7000-8000-0000000000a2'
const seller = '01990000-0000-7000-8000-0000000000a3'
const listingA = '01990000-0000-7000-8000-0000000000b1'
const listingB = '01990000-0000-7000-8000-0000000000b2'
const listingC = '01990000-0000-7000-8000-0000000000b3'

/** 固定时刻：B 最新、C 次之、A 最老（毫秒精度——JS `Date` 解析 ISO 微秒会把小数截到毫秒）。 */
const AT = {
  a: new Date('2026-09-12T03:00:00.001Z'),
  c: new Date('2026-09-12T03:00:00.002Z'),
  b: new Date('2026-09-12T03:00:00.003Z'),
} as const

const WINDOW_START = new Date('2026-08-20T00:00:00.000000Z')

beforeAll(async () => {
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  await migrate(db, { migrationsFolder })

  for (const [i, uid] of [me, other, seller].entries()) {
    await db.execute(sql`
      INSERT INTO users (id, student_no, password_hash, nickname)
      VALUES (${uid}, ${`vh${process.pid}_${i}`}, 'test-hash', '足迹测试')
    `)
  }
  for (const listingId of [listingA, listingB, listingC]) {
    const listingNo = await reserveTestListingNo(db, listingId)
    await db.execute(sql`
      INSERT INTO listings (id, listing_no, seller_id, title, description, price_cents, category, condition, status)
      VALUES (${listingId}, ${listingNo}, ${seller}, '商品', '描述', 16000, 'DIGITAL', 'GOOD', 'ACTIVE')
    `)
  }
  await db.execute(sql`
    INSERT INTO listing_images (listing_id, object_key, sort_order)
    VALUES (${listingA}, 'listings/seller/cover.png', 0)
  `)
})

afterAll(async () => {
  await db.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

describe('view history store (integration)', () => {
  test('upsert 单调：补发的旧事件不会把 last_viewed_at 倒退', async () => {
    await recordViewHistoryWith(db, [{ userId: me, listingId: listingA, viewedAt: AT.b }])
    // 离线队列补发：几分钟前的事件晚到。
    await recordViewHistoryWith(db, [{ userId: me, listingId: listingA, viewedAt: AT.a }])

    const rows = await db
      .select({ lastViewedAt: listingViewHistory.lastViewedAt })
      .from(listingViewHistory)
      .where(and(eq(listingViewHistory.userId, me), eq(listingViewHistory.listingId, listingA)))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.lastViewedAt.toISOString()).toBe(AT.b.toISOString())

    await store.clearViewHistory(me)
  })

  test('列表按最近浏览倒序、多取一行给调用方判下一页，total 与窗口一致', async () => {
    await store.clearViewHistory(me)
    await recordViewHistoryWith(db, [
      { userId: me, listingId: listingA, viewedAt: AT.a },
      { userId: me, listingId: listingB, viewedAt: AT.b },
      { userId: me, listingId: listingC, viewedAt: AT.c },
    ])
    // 窗口外的行单独造一件商品：A 已经有窗口内的记录，GREATEST 不会让它被旧值覆盖。
    const listingD = '01990000-0000-7000-8000-0000000000b4'
    const listingNo = await reserveTestListingNo(db, listingD)
    await db.execute(sql`
      INSERT INTO listings (id, listing_no, seller_id, title, description, price_cents, category, condition, status)
      VALUES (${listingD}, ${listingNo}, ${seller}, '窗口外商品', '描述', 100, 'OTHER', 'GOOD', 'ACTIVE')
    `)
    await recordViewHistoryWith(db, [
      { userId: me, listingId: listingD, viewedAt: new Date('2026-01-01T00:00:00.000000Z') },
    ])

    const rows = await store.listViewHistory(me, 10, null, WINDOW_START)
    expect(rows.map((row) => row.id)).toEqual([listingB, listingC, listingA])
    expect(rows[0]?.viewedAt).toBe('2026-09-12T03:00:00.003Z')
    expect(rows[0]?.viewedAtCursor).toBe('2026-09-12T03:00:00.003000Z')
    // 窗口外的那条既不在列表里，也不计入 total。
    expect(await store.totalViewHistory(me, WINDOW_START)).toBe(3)

    // 多取一行：limit=2 时返回 3 行（A 是窗口内第 3 条），调用方据此判 nextCursor。
    expect((await store.listViewHistory(me, 2, null, WINDOW_START)).map((row) => row.id)).toEqual([
      listingB,
      listingC,
      listingA,
    ])
  })

  test('游标翻页不重不漏', async () => {
    await store.clearViewHistory(me)
    await recordViewHistoryWith(db, [
      { userId: me, listingId: listingA, viewedAt: AT.a },
      { userId: me, listingId: listingB, viewedAt: AT.b },
      { userId: me, listingId: listingC, viewedAt: AT.c },
    ])

    // store 故意多取一行（limit+1）给调用方判下一页：页数据要自己 slice。
    const first = (await store.listViewHistory(me, 2, null, WINDOW_START)).slice(0, 2)
    const last = first.at(1)
    if (!last) throw new Error('第一页应有 2 行')
    const second = (
      await store.listViewHistory(
        me,
        2,
        { viewedAt: last.viewedAtCursor, listingId: last.id },
        WINDOW_START,
      )
    ).slice(0, 2)

    expect([...first, ...second].map((row) => row.id)).toEqual([listingB, listingC, listingA])
  })

  test('游标保留微秒：服务端/脚本写入的亚毫秒时刻也能精确翻页', async () => {
    await store.clearViewHistory(me)
    // 客户端上报是毫秒，但表对任何写入者开放（脚本 / 将来的服务端写入）——微秒必须原样进游标，
    // 否则同毫秒的两行会在翻页时被截断成同一个边界值。
    await db.execute(sql`
      INSERT INTO listing_view_history (user_id, listing_id, last_viewed_at)
      VALUES (${me}, ${listingB}, '2026-09-12T03:00:00.000300Z'::timestamptz),
             (${me}, ${listingC}, '2026-09-12T03:00:00.000200Z'::timestamptz)
    `)

    const first = await store.listViewHistory(me, 1, null, WINDOW_START)
    expect(first[0]?.id).toBe(listingB)
    expect(first[0]?.viewedAt).toBe('2026-09-12T03:00:00.000Z')
    expect(first[0]?.viewedAtCursor).toBe('2026-09-12T03:00:00.000300Z')

    const boundary = first[0]
    if (!boundary) throw new Error('第一页应有 1 行')
    const second = await store.listViewHistory(
      me,
      1,
      { viewedAt: boundary.viewedAtCursor, listingId: boundary.id },
      WINDOW_START,
    )
    expect(second.map((row) => row.id)).toEqual([listingC])
  })

  test('同一时刻的 tie-break：last_viewed_at 完全相等时按商品 id 兜底，翻页不重不漏', async () => {
    await store.clearViewHistory(me)
    // 两行时刻**完全相同**：排序只能靠 `listings.id DESC` 的 tie-break 分支，
    // 游标的第二个 or 分支（同时间戳比 id）也才会被走到。
    await db.execute(sql`
      INSERT INTO listing_view_history (user_id, listing_id, last_viewed_at)
      VALUES (${me}, ${listingB}, '2026-09-12T04:00:00.000000Z'::timestamptz),
             (${me}, ${listingC}, '2026-09-12T04:00:00.000000Z'::timestamptz)
    `)

    const first = await store.listViewHistory(me, 1, null, WINDOW_START)
    expect(first[0]?.id).toBe(listingC)

    const boundary = first[0]
    if (!boundary) throw new Error('第一页应有 1 行')
    const second = await store.listViewHistory(
      me,
      1,
      { viewedAt: boundary.viewedAtCursor, listingId: boundary.id },
      WINDOW_START,
    )

    // 并集不重不漏（方向取反会让第二页重复 listingC 或整页丢掉 listingB）。
    expect([...first.slice(0, 1), ...second.slice(0, 1)].map((row) => row.id)).toEqual([
      listingC,
      listingB,
    ])
  })

  test('清空只删本人足迹，返回行数且幂等', async () => {
    await store.clearViewHistory(me)
    await store.clearViewHistory(other)
    await recordViewHistoryWith(db, [
      { userId: me, listingId: listingA, viewedAt: AT.a },
      { userId: other, listingId: listingB, viewedAt: AT.b },
    ])

    expect(await store.clearViewHistory(me)).toBe(1)
    expect(await store.clearViewHistory(me)).toBe(0)
    // 别人的行不受影响。
    expect(await store.totalViewHistory(other, WINDOW_START)).toBe(1)

    await store.clearViewHistory(other)
  })

  test('商品被物理删除时足迹级联消失', async () => {
    const listingE = '01990000-0000-7000-8000-0000000000b5'
    const listingNo = await reserveTestListingNo(db, listingE)
    await db.insert(listings).values({
      id: listingE,
      listingNo,
      sellerId: seller,
      title: '待删除商品',
      description: '描述',
      priceCents: 100,
      category: 'OTHER',
      condition: 'GOOD',
    })
    await recordViewHistoryWith(db, [{ userId: me, listingId: listingE, viewedAt: AT.b }])
    expect(await store.totalViewHistory(me, WINDOW_START)).toBe(1)

    await db.delete(listings).where(eq(listings.id, listingE))
    expect(await store.totalViewHistory(me, WINDOW_START)).toBe(0)
  })
})
