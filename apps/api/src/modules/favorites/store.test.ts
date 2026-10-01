import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb } from '@fish/db/client'
import { favorites } from '@fish/db/schema/favorites'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { decodeFavoritesCursor, encodeFavoritesCursor } from './cursor'
import { createSqlFavoriteStore } from './store'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../../../packages/db/src/migrations', import.meta.url),
)

/** 与 profile / wishes 的 store 测试相同的 scratch 库模式：互不污染开发库。 */
const scratchDatabase = `fish_favorites_store_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const admin = createDb(databaseUrl)
const db = createDb(scratchUrl)
const store = createSqlFavoriteStore(db)

/**
 * drizzle 的 bun-sql `execute` 返回的是 `PgRaw`（thenable，但不是真 `Promise`），
 * `expect(...).rejects` 认不出来 —— 这里显式 await 一次再判。
 */
async function expectRejects(run: () => unknown): Promise<void> {
  try {
    await run()
  } catch {
    return
  }
  throw new Error('期望这次写入被拒绝，但它成功了')
}

const me = '01990000-0000-7000-8000-0000000000a1'
const other = '01990000-0000-7000-8000-0000000000a2'
const seller = '01990000-0000-7000-8000-0000000000a3'
const listingA = '01990000-0000-7000-8000-0000000000b1'
const listingB = '01990000-0000-7000-8000-0000000000b2'
const listingC = '01990000-0000-7000-8000-0000000000b3'

/** 固定 created_at 才能断言顺序：B 最新、C 次之、A 最老。 */
const AT = {
  a: '2026-09-12T03:00:00.000100Z',
  c: '2026-09-12T03:00:00.000200Z',
  b: '2026-09-12T03:00:00.000300Z',
} as const

beforeAll(async () => {
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  await migrate(db, { migrationsFolder })

  for (const [i, uid] of [me, other, seller].entries()) {
    await db.execute(sql`
      INSERT INTO users (id, student_no, password_hash, nickname)
      VALUES (${uid}, ${`fav${process.pid}_${i}`}, 'test-hash', '收藏测试')
    `)
  }
  for (const listingId of [listingA, listingB, listingC]) {
    const listingNo = await reserveTestListingNo(db, listingId)
    await db.execute(sql`
      INSERT INTO listings (id, listing_no, seller_id, title, description, price_cents, category, condition, status)
      VALUES (${listingId}, ${listingNo}, ${seller}, '商品', '描述', 16000, 'DIGITAL', 'GOOD', 'ACTIVE')
    `)
  }
  // 封面只认 sort_order = 0（#6 契约 §1）：A 有 0 号图并额外给一张 9 号图。
  await db.execute(sql`
    INSERT INTO listing_images (listing_id, object_key, sort_order)
    VALUES (${listingA}, 'listings/seller/cover.png', 0),
           (${listingA}, 'listings/seller/later.png', 9)
  `)
})

afterAll(async () => {
  await db.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

describe('favorite store (integration)', () => {
  test('收藏幂等：重复收藏只有一行，且不改写首次 created_at', async () => {
    await store.addFavorite(me, listingA)
    const [first] = await db
      .select({ createdAt: favorites.createdAt })
      .from(favorites)
      .where(sql`${favorites.userId} = ${me} AND ${favorites.listingId} = ${listingA}`)

    await store.addFavorite(me, listingA)
    const rows = await db
      .select({ createdAt: favorites.createdAt })
      .from(favorites)
      .where(sql`${favorites.userId} = ${me} AND ${favorites.listingId} = ${listingA}`)

    expect(rows).toHaveLength(1)
    // 列表顺序靠它稳定：重复点击"收藏"不能把条目顶到最前。
    expect(rows[0]?.createdAt.toISOString()).toBe(first?.createdAt.toISOString())
    await store.removeFavorite(me, listingA)
  })

  test('取消收藏幂等：没收藏过也当成功', async () => {
    await store.removeFavorite(me, listingB)
    await store.removeFavorite(me, listingB)
    expect(
      (
        await db
          .select({ id: favorites.id })
          .from(favorites)
          .where(sql`${favorites.userId} = ${me} AND ${favorites.listingId} = ${listingB}`)
      ).length,
    ).toBe(0)
  })

  test('同一用户对同一商品的唯一约束在 DB 层兜底', async () => {
    // 绕过 store 直插两次：唯一索引是幂等的最后一道防线（服务端并发下先读后写会漏）。
    const insert = sql`INSERT INTO favorites (user_id, listing_id) VALUES (${me}, ${listingC})`
    await db.execute(insert)
    // 必须 await：不 await 的话这次拒绝会在后台悬空，等到下一条用例才炸出来。
    await expectRejects(() => db.execute(insert))
    await store.removeFavorite(me, listingC)
  })

  test('列表按 created_at DESC 排序、游标翻页不重不漏、到底为 null', async () => {
    for (const [listingId, at] of [
      [listingA, AT.a],
      [listingC, AT.c],
      [listingB, AT.b],
    ] as const) {
      await db.execute(sql`
        INSERT INTO favorites (user_id, listing_id, created_at) VALUES (${me}, ${listingId}, ${at}::timestamptz)
      `)
    }

    // store 的契约是「多取一行由调用方判断还有没有下一页」，所以 limit=2 会回 3 行。
    const peek = await store.listFavorites(me, 2, null)
    expect(peek.map((r) => r.id)).toEqual([listingB, listingC, listingA])

    const firstPage = peek.slice(0, 2)
    const last = firstPage.at(-1)
    if (!last) throw new Error('首页为空')
    const cursor = decodeFavoritesCursor(
      encodeFavoritesCursor({ createdAt: last.favoritedAtCursor, listingId: last.id }),
    )
    const secondPage = await store.listFavorites(me, 2, cursor)
    expect(secondPage.map((r) => r.id)).toEqual([listingA])

    const afterLast = secondPage.at(-1)
    if (!afterLast) throw new Error('第二页为空')
    expect(
      await store.listFavorites(me, 2, {
        createdAt: afterLast.favoritedAtCursor,
        listingId: afterLast.id,
      }),
    ).toEqual([])

    expect(await store.totalFavorites(me)).toBe(3)
  })

  test('只回自己的收藏：换账号看不到别人的', async () => {
    await store.addFavorite(other, listingA)
    expect((await store.listFavorites(other, 20, null)).map((r) => r.id)).toEqual([listingA])
    expect(await store.totalFavorites(other)).toBe(1)
    // 我这边不受影响（上一条用例的三条仍在）。
    expect(await store.totalFavorites(me)).toBe(3)
    await store.removeFavorite(other, listingA)
  })

  test('封面只认 sort_order = 0，取不到就是 null', async () => {
    const rows = await store.listFavorites(me, 20, null)
    const withCover = rows.find((r) => r.id === listingA)
    const withoutCover = rows.find((r) => r.id === listingC)
    expect(withCover?.coverObjectKey).toBe('listings/seller/cover.png')
    expect(withoutCover?.coverObjectKey).toBeNull()
  })

  test('卡片源字段齐备（清单品编号与时间，供共享投影使用）', async () => {
    const [row] = await store.listFavorites(me, 1, null)
    expect(row?.listingNo).toBeGreaterThan(0n)
    expect(row?.status).toBe('ACTIVE')
    expect(row?.favoritedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    // 游标用的是微秒，两个字段必须同源但精度不同。
    expect(row?.favoritedAtCursor).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
  })

  test('卖家公开子集随行取出（#191：卡片源必有 seller，且只有四个公开字段）', async () => {
    const [row] = await store.listFavorites(me, 1, null)
    // 这里仍是库内原始 uuid，`usr_` 前缀由 `toListingCard` 在出网时编码。
    expect(row?.seller.id).toBe(seller)
    expect(row?.seller.nickname).toBe('收藏测试')
    expect(row?.seller.avatarUrl).toBeNull()
    expect(row?.seller.authStatus).toBe('UNVERIFIED')
    // 关键回归护栏：投影只允许这四个字段。少一个则卡片渲染不出来，
    // 多一个就是学号 / 密码哈希 / 邮箱从卖家列表往外漏。
    expect(Object.keys(row?.seller ?? {}).sort()).toEqual([
      'authStatus',
      'avatarUrl',
      'id',
      'nickname',
    ])
  })

  test('listingState 回商品状态、审核态、治理下架时间与卖家，不存在回 null', async () => {
    expect(await store.listingState(listingA)).toEqual({
      status: 'ACTIVE',
      moderationStatus: 'APPROVED',
      governanceDelistedAt: null,
      sellerId: seller,
    })
    expect(await store.listingState('01990000-0000-7000-8000-0000000000ff')).toBeNull()
  })

  test('商品行被删掉时收藏随 listings 的 deleteListingAtomic 一起消失', async () => {
    // 这里只守外键那一半：favorites → listings 是 NO ACTION，所以"删商品带走收藏"
    // 不可能由外键顺手完成，必须显式先删（`listings/store.ts` 的 deleteListingAtomic，
    // 端到端行为由 `listings/store.test.ts` 覆盖）。直接删商品行应当被外键拒绝。
    await store.addFavorite(other, listingB)
    await expectRejects(() => db.execute(sql`DELETE FROM listings WHERE id = ${listingB}`))
    await store.removeFavorite(other, listingB)
  })
})
