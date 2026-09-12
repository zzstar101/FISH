import { afterAll, describe, expect, test } from 'bun:test'
import { createDb } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { listings } from '@fish/db/schema/listings'
import { matches } from '@fish/db/schema/matches'
import { notifications } from '@fish/db/schema/notifications'
import { users } from '@fish/db/schema/users'
import { wishes } from '@fish/db/schema/wishes'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { createMatchEngine } from './engine'

// 与 packages/db 的集成测试同一约定：没有 DATABASE_URL 就明确失败，而不是静默跳过。
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const db = createDb(databaseUrl)
afterAll(async () => {
  await db.$client.close()
})

const engine = createMatchEngine(db)

/**
 * 隔离手段：本地库里通常还有 `db:seed` 的数据（6 个商品 / 2 个愿望）。
 * 引擎的候选集是**全库**的，所以断言分两类：
 *
 * 1. 只针对自己创建的行（`matchRows` / `matchNotifications` 都按自己的 id 过滤）；
 * 2. fixture 一律用 `OTHER` 分类 + 随机关键词——seed 的商品与愿望都不在 `OTHER`，
 *    且关键词不会命中 seed 的标题，于是"自己的那对"是唯一可能命中阈值的组合。
 *
 * 如果将来 seed 里出现了 OTHER 分类的数据，第 2 条假设需要重挑一个空分类
 * （目前 BEAUTY / TRANSPORT / OTHER 都是空的）。
 */
const ISOLATED_CATEGORY = 'OTHER' as const

let seq = 0
const uniqueKeyword = () => `qa${Date.now()}${seq++}`

async function createUser(): Promise<string> {
  const rows = await db
    .insert(users)
    .values({
      studentNo: `matching-${Date.now()}-${seq++}`,
      passwordHash: 'test-not-a-real-hash',
      nickname: '匹配引擎测试',
    })
    .returning({ id: users.id })
  const row = rows[0]
  if (!row) throw new Error('insert users 未返回行')
  return row.id
}

async function createListing(
  sellerId: string,
  keyword: string,
  overrides: Partial<typeof listings.$inferInsert> = {},
): Promise<string> {
  const id = newId()
  await db.insert(listings).values({
    id,
    sellerId,
    title: `测试商品 ${keyword}`,
    description: '匹配引擎集成测试',
    priceCents: 16000,
    category: ISOLATED_CATEGORY,
    condition: 'GOOD',
    ...overrides,
  })
  return id
}

async function createWish(
  userId: string,
  keyword: string,
  overrides: Partial<typeof wishes.$inferInsert> = {},
): Promise<string> {
  const id = newId()
  await db.insert(wishes).values({
    id,
    userId,
    keyword,
    category: ISOLATED_CATEGORY,
    budgetMaxCents: 20000,
    ...overrides,
  })
  return id
}

async function matchRows(listingId: string, wishId: string) {
  return db
    .select()
    .from(matches)
    .where(and(eq(matches.listingId, listingId), eq(matches.wishId, wishId)))
}

async function matchNotifications(userId: string, wishId: string) {
  return db
    .select({ id: notifications.id, payload: notifications.payload })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.type, 'MATCH'),
        sql`${notifications.payload}->>'wishId' = ${wishId}`,
      ),
    )
}

/** 两个用户（卖家 / 愿望所有者）+ 用到的行，跑完一律按 id 清干净（users 没有级联）。 */
async function withFixture(
  run: (ctx: { sellerId: string; buyerId: string }) => Promise<void>,
): Promise<void> {
  const sellerId = await createUser()
  const buyerId = await createUser()

  try {
    await run({ sellerId, buyerId })
  } finally {
    await db.delete(notifications).where(inArray(notifications.userId, [sellerId, buyerId]))
    await db.delete(wishes).where(inArray(wishes.userId, [sellerId, buyerId]))
    await db.delete(listings).where(inArray(listings.sellerId, [sellerId, buyerId]))
    await db.delete(users).where(inArray(users.id, [sellerId, buyerId]))
  }
}

describe('matchListing', () => {
  test('写入匹配与一条通知，收件人是愿望所有者', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const listingId = await createListing(sellerId, keyword)
      const wishId = await createWish(buyerId, keyword)

      const result = await engine.matchListing(listingId)

      expect(result.skipped).toBeNull()
      expect(result.matched).toBeGreaterThanOrEqual(1)

      const rows = await matchRows(listingId, wishId)
      expect(rows).toHaveLength(1)
      // 同分类 + 标题含关键词 + 在预算内 → 三个分项都满分（契约 §3.2）。
      expect(rows[0]?.score).toBe(100)
      expect(rows[0]?.categoryScore).toBe(100)
      expect(rows[0]?.keywordScore).toBe(100)
      expect(rows[0]?.priceScore).toBe(100)

      const notes = await matchNotifications(buyerId, wishId)
      expect(notes).toHaveLength(1)
      // payload 必须是 jsonb object 且 `->>'matchId'` 取得到值（jsonParam 的回归点）。
      expect(notes[0]?.payload.matchId).toBe(rows[0]?.id)
    })
  })

  test('重复运行不重复建行或建通知，只覆盖分数', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const listingId = await createListing(sellerId, keyword)
      const wishId = await createWish(buyerId, keyword)

      await engine.matchListing(listingId)
      // 改价 → priceScore 50（16000 → 30000，2 倍预算 = 40000）→ 总分 85。
      await db.update(listings).set({ priceCents: 30000 }).where(eq(listings.id, listingId))

      const second = await engine.matchListing(listingId)

      expect(second.created).toBe(0)
      expect(second.matched).toBe(1)
      expect(second.downgraded).toBe(0)
      const rows = await matchRows(listingId, wishId)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.score).toBe(85)
      expect(rows[0]?.priceScore).toBe(50)
      expect(await matchNotifications(buyerId, wishId)).toHaveLength(1)
    })
  })

  test('分数低于阈值时不落库、不建通知', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const listingId = await createListing(sellerId, keyword)
      // 关键词与分类都不命中 → 0.35×0 + 0.35×0 + 0.30×100 = 30。
      const wishId = await createWish(buyerId, `另一个关键词${keyword}`, { category: 'BOOKS' })

      const result = await engine.matchListing(listingId)

      expect(result.skipped).toBeNull()
      expect(result.matched).toBe(0)
      expect(result.created).toBe(0)
      expect(await matchRows(listingId, wishId)).toHaveLength(0)
      expect(await matchNotifications(buyerId, wishId)).toHaveLength(0)
    })
  })

  test('候选集排除自己的愿望与超出 2 倍预算的愿望', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const listingId = await createListing(sellerId, keyword)
      // 卖家自己的愿望。
      const ownWishId = await createWish(sellerId, keyword)
      // 价格 16000 > 2 × 7000 → 收窄掉。
      const poorWishId = await createWish(buyerId, keyword, { budgetMaxCents: 7000 })

      await engine.matchListing(listingId)

      expect(await matchRows(listingId, ownWishId)).toHaveLength(0)
      expect(await matchRows(listingId, poorWishId)).toHaveLength(0)
    })
  })

  test('商品不是 ACTIVE 或不存在时跳过', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const offlineId = await createListing(sellerId, keyword, { status: 'OFFLINE' })
      await createWish(buyerId, keyword)

      expect(await engine.matchListing(offlineId)).toMatchObject({ skipped: 'target-not-active' })
      expect(await engine.matchListing(newId())).toMatchObject({ skipped: 'target-missing' })
    })
  })

  /**
   * 掉出阈值：改标题后关键词不再命中（分类与价格仍满分）→ 65 分。
   * 这一对仍在本轮收窄候选里，所以**必须**被覆盖成真实分数；否则行里还是 100，
   * 读接口的阈值过滤就永远看不到它（审查发现的 P1）。
   */
  test('改标题后掉出阈值：既有行被覆盖成低分，通知不增加', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const listingId = await createListing(sellerId, keyword)
      const wishId = await createWish(buyerId, keyword)
      await engine.matchListing(listingId)
      expect((await matchRows(listingId, wishId))[0]?.score).toBe(100)

      await db
        .update(listings)
        .set({ title: `完全无关的标题 ${keyword.replace('qa', 'zz')}` })
        .where(eq(listings.id, listingId))

      const result = await engine.matchListing(listingId)

      expect(result).toMatchObject({ matched: 0, downgraded: 1 })
      const rows = await matchRows(listingId, wishId)
      expect(rows).toHaveLength(1)
      // 65 = 分类 100 + 关键词 0 + 价格 100；低于阈值 → 读接口不会返回它（§9.7）。
      expect(rows[0]?.score).toBe(65)
      expect(rows[0]?.keywordScore).toBe(0)
      expect(await matchNotifications(buyerId, wishId)).toHaveLength(1)
    })
  })

  /*
   * 可见性与计数必须与读接口的策略一致（方向相关）：
   * wish 侧隐藏 OFFLINE 商品、保留 RESERVED/SOLD（卡片带状态角标）。
   * 这条区分是审查抓到的 P1——引擎曾把"对端 ACTIVE"当成"有效"，于是接口照旧展示
   * RESERVED 的匹配而计数说它无效。
   */
  test('商品转 RESERVED/SOLD 后仍然算"可见"（wish 侧策略），转 OFFLINE 才算不可见', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const listingId = await createListing(sellerId, keyword)
      const wishId = await createWish(buyerId, keyword)
      await engine.matchListing(listingId)

      await db.update(listings).set({ status: 'RESERVED' }).where(eq(listings.id, listingId))
      expect(await engine.matchWish(wishId)).toMatchObject({ matched: 1, downgraded: 0 })
      expect((await matchRows(listingId, wishId))[0]?.score).toBe(100)

      await db.update(listings).set({ status: 'SOLD' }).where(eq(listings.id, listingId))
      expect(await engine.matchWish(wishId)).toMatchObject({ matched: 1, downgraded: 0 })

      await db.update(listings).set({ status: 'OFFLINE' }).where(eq(listings.id, listingId))
      expect(await engine.matchWish(wishId)).toMatchObject({ matched: 0, downgraded: 1 })
      // 行仍在、分数仍是真实裸分——可见性由读接口的谓词决定，引擎不删行。
      expect((await matchRows(listingId, wishId))[0]?.score).toBe(100)
    })
  })

  /**
   * 掉出**价格**收窄（`price > 2 × budget_max`）：这一对的裸分恰好是 70
   * （分类 100 + 关键词 100 + 价格 0），所以只按 `score >= 阈值` 判断会把它当成有效匹配——
   * 而新建这种同时对不会建行（候选 SQL 直接排除），于是"新建时不匹配、编辑后却可见"。
   * 修法是重评时也带上收窄判据（审查发现的 P1）。
   */
  test('改价到 2 倍预算以上：既有行被判为无效（裸分 70 不算匹配）', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const listingId = await createListing(sellerId, keyword)
      const wishId = await createWish(buyerId, keyword, { budgetMaxCents: 20000 })
      await engine.matchListing(listingId)
      expect((await matchRows(listingId, wishId))[0]?.score).toBe(100)

      // 50000 > 2 × 20000 → 掉出价格收窄。
      await db.update(listings).set({ priceCents: 50000 }).where(eq(listings.id, listingId))

      const result = await engine.matchListing(listingId)

      expect(result).toMatchObject({ matched: 0, downgraded: 1 })
      const rows = await matchRows(listingId, wishId)
      // 行保留，分数是**真实裸分** 70；读接口靠价格收窄谓词把它挡掉（见 apps/api 的 service.test.ts）。
      expect(rows).toHaveLength(1)
      expect(rows[0]?.score).toBe(70)
      expect(rows[0]?.priceScore).toBe(0)
      // 已经是既有行，不该再发通知。
      expect(await matchNotifications(buyerId, wishId)).toHaveLength(1)
    })
  })

  // 计数不变式的边界：在收窄集合内、分数不够、又没有既有行 → 评估了但既不 matched 也不 downgraded。
  test('候选在收窄集合内但分数不够且没有行：matched 与 downgraded 都是 0', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const listingId = await createListing(sellerId, keyword)
      // 分类与价格都成立（进得了收窄集合），但关键词一个 token 都不命中 → 65 分，且没有既有行。
      // 注意不能用含空格的 keyword：那是多 token，命中其中一个就会把分数抬过阈值。
      const wishId = await createWish(buyerId, `无关需求${uniqueKeyword()}`)

      const result = await engine.matchListing(listingId)

      expect(result).toEqual({ evaluated: 1, matched: 0, created: 0, downgraded: 0, skipped: null })
      expect(await matchRows(listingId, wishId)).toHaveLength(0)
    })
  })

  /**
   * 掉出**收窄集合**：改分类（DIGITAL → BOOKS）后这对不再被候选 SQL 选中。
   * 只加读接口过滤是不够的——必须把"已有行"也拉进本轮评估，否则旧分数永远留着。
   */
  test('改分类后掉出候选集：既有行同样被重新评估并覆盖', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const listingId = await createListing(sellerId, keyword)
      const wishId = await createWish(buyerId, keyword)
      await engine.matchListing(listingId)

      await db.update(listings).set({ category: 'APPAREL' }).where(eq(listings.id, listingId))

      const result = await engine.matchListing(listingId)

      expect(result).toMatchObject({ matched: 0, downgraded: 1 })
      const rows = await matchRows(listingId, wishId)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.score).toBe(65)
      expect(rows[0]?.categoryScore).toBe(0)
      expect(await matchNotifications(buyerId, wishId)).toHaveLength(1)
    })
  })
})

describe('matchWish', () => {
  test('只匹配在售商品，且不发通知给卖家', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const activeId = await createListing(sellerId, keyword)
      const offlineId = await createListing(sellerId, keyword, { status: 'OFFLINE' })
      const wishId = await createWish(buyerId, keyword)

      const result = await engine.matchWish(wishId)

      expect(result.skipped).toBeNull()
      expect(await matchRows(activeId, wishId)).toHaveLength(1)
      expect(await matchRows(offlineId, wishId)).toHaveLength(0)
      // 通知只给愿望所有者（契约 §3.4）。
      expect(await matchNotifications(buyerId, wishId)).toHaveLength(1)
      expect(await matchNotifications(sellerId, wishId)).toHaveLength(0)
    })
  })

  test('跳过自己发布的商品与非 ACTIVE 的愿望', async () => {
    await withFixture(async ({ buyerId }) => {
      const keyword = uniqueKeyword()
      // 愿望所有者自己发的商品不该匹配到自己的愿望。
      const ownListingId = await createListing(buyerId, keyword)
      const closedWishId = await createWish(buyerId, keyword, { status: 'CLOSED' })

      expect(await engine.matchWish(closedWishId)).toMatchObject({ skipped: 'target-not-active' })

      const activeWishId = await createWish(buyerId, keyword)
      await engine.matchWish(activeWishId)
      expect(await matchRows(ownListingId, activeWishId)).toHaveLength(0)
      expect(await engine.matchWish(newId())).toMatchObject({ skipped: 'target-missing' })
    })
  })

  test('不限分类的愿望按归一化分数匹配', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const listingId = await createListing(sellerId, keyword)
      const wishId = await createWish(buyerId, keyword, { category: null })

      await engine.matchWish(wishId)

      const rows = await matchRows(listingId, wishId)
      expect(rows).toHaveLength(1)
      // 分类不参与计分 → 落库的 categoryScore 是 0，总分按剩余两项归一化（契约 §3.2）。
      expect(rows[0]?.categoryScore).toBe(0)
      expect(rows[0]?.score).toBe(100)
    })
  })

  // listing 侧策略与 wish 侧不同：只展示仍 ACTIVE 的（他人的）愿望。
  test('愿望转 CLOSED 后不再"可见"（listing 侧策略）', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const listingId = await createListing(sellerId, keyword)
      const wishId = await createWish(buyerId, keyword)
      await engine.matchListing(listingId)
      expect(await engine.matchListing(listingId)).toMatchObject({ matched: 1, downgraded: 0 })

      await db.update(wishes).set({ status: 'CLOSED' }).where(eq(wishes.id, wishId))

      expect(await engine.matchListing(listingId)).toMatchObject({ matched: 0, downgraded: 1 })
      expect((await matchRows(listingId, wishId))[0]?.score).toBe(100)
    })
  })

  // 两个方向写的是同一把唯一键（`(listing_id, wish_id)`），所以先 listing 后 wish
  // 不能变成两行 / 两条通知——这是"同一对不重复"的跨方向验证。
  test('两个方向交叉触发同一对：仍只有一行、一条通知', async () => {
    await withFixture(async ({ sellerId, buyerId }) => {
      const keyword = uniqueKeyword()
      const listingId = await createListing(sellerId, keyword)
      const wishId = await createWish(buyerId, keyword)

      const fromListing = await engine.matchListing(listingId)
      const fromWish = await engine.matchWish(wishId)

      expect(fromListing.created).toBe(1)
      expect(fromWish.created).toBe(0)
      expect(await matchRows(listingId, wishId)).toHaveLength(1)
      expect(await matchNotifications(buyerId, wishId)).toHaveLength(1)
    })
  })
})
