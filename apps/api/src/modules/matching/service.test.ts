import { afterAll, expect, test } from 'bun:test'
import { createDb } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { listingImages, listings } from '@fish/db/schema/listings'
import { matches } from '@fish/db/schema/matches'
import { users } from '@fish/db/schema/users'
import { wishes } from '@fish/db/schema/wishes'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { inArray } from 'drizzle-orm'
import { createMatchingService, MatchingServiceError } from './service'
import { createSqlMatchingStore } from './store'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const db = createDb(databaseUrl)

// 每个测试文件都会建自己的连接池。不关掉的话，`bun test` 并行跑全量测试会把本地 PG 的
// max_connections（默认 100）顶爆，表现为 53300 `too many clients already`——那时失败的是
// 恰好抢不到连接的那个文件，看上去像随机的 flaky。
afterAll(async () => {
  await db.$client.close()
})
const publicListing = (id: string) => encodePublicId(PUBLIC_ID_PREFIX.listing, id)
const publicWish = (id: string) => encodePublicId(PUBLIC_ID_PREFIX.wish, id)
const service = createMatchingService({
  store: createSqlMatchingStore(db),
  storage: { publicUrl: (key) => `https://cdn.test/${key}` },
})

let seq = 0

async function createUser(): Promise<string> {
  const rows = await db
    .insert(users)
    .values({
      studentNo: `matching-read-${Date.now()}-${seq++}`,
      passwordHash: 'test-not-a-real-hash',
      nickname: '匹配读路径测试',
    })
    .returning({ id: users.id })
  const row = rows[0]
  if (!row) throw new Error('insert users 未返回行')
  return row.id
}

async function createListing(
  sellerId: string,
  overrides: Partial<typeof listings.$inferInsert> = {},
): Promise<string> {
  const id = overrides.id ?? newId()
  await db.insert(listings).values({
    id,
    listingNo: await reserveTestListingNo(db, id),
    sellerId,
    title: '罗技 K380 键盘',
    description: '读路径测试',
    priceCents: 16000,
    category: 'DIGITAL',
    condition: 'GOOD',
    ...overrides,
  })
  return id
}

async function createWish(
  userId: string,
  overrides: Partial<typeof wishes.$inferInsert> = {},
): Promise<string> {
  const id = overrides.id ?? newId()
  await db.insert(wishes).values({
    id,
    userId,
    keyword: '机械键盘',
    category: 'DIGITAL',
    budgetMaxCents: 20000,
    ...overrides,
  })
  return id
}

/** matches 只有 (listing_id, wish_id) 唯一键，分数直接写死，读路径测试不经过引擎。 */
async function createMatch(listingId: string, wishId: string, score: number): Promise<void> {
  await db.insert(matches).values({
    listingId,
    wishId,
    score,
    categoryScore: 100,
    keywordScore: 100,
    priceScore: 100,
  })
}

async function withOwners(run: (ids: { ownerId: string; otherId: string }) => Promise<void>) {
  const ownerId = await createUser()
  const otherId = await createUser()
  try {
    await run({ ownerId, otherId })
  } finally {
    // matches / listing_images 都随 listings、wishes 级联删除。
    await db.delete(listings).where(inArray(listings.sellerId, [ownerId, otherId]))
    await db.delete(wishes).where(inArray(wishes.userId, [ownerId, otherId]))
    await db.delete(users).where(inArray(users.id, [ownerId, otherId]))
  }
}

test('wish 侧：排除 OFFLINE 商品（items 与 total 都不算它），否则按分数降序', async () => {
  await withOwners(async ({ ownerId, otherId }) => {
    const wishId = await createWish(ownerId)
    const lower = await createListing(otherId)
    const higher = await createListing(otherId)
    const offline = await createListing(otherId, { status: 'OFFLINE' })

    await createMatch(lower, wishId, 80)
    await createMatch(higher, wishId, 95)
    await createMatch(offline, wishId, 99)

    const response = await service.listByWish(ownerId, wishId, 10)

    expect(response.total).toBe(2)
    expect(response.items.map((item) => item.score)).toEqual([95, 80])
    expect(response.items.map((item) => item.listing.id)).toEqual(
      [higher, lower].map(publicListing),
    )
    expect(
      response.items.every((item) => /^[1-9][0-9]{11}$/.test(item.listing.listingNo ?? '')),
    ).toBe(true)
    expect(response.items[0]?.listing.coverUrl).toBeNull()
  })
})

test('wish 侧：limit 只影响 items，total 仍是全量', async () => {
  await withOwners(async ({ ownerId, otherId }) => {
    const wishId = await createWish(ownerId)
    await createMatch(await createListing(otherId), wishId, 80)
    await createMatch(await createListing(otherId), wishId, 95)

    const response = await service.listByWish(ownerId, wishId, 1)

    expect(response.items).toHaveLength(1)
    expect(response.total).toBe(2)
  })
})

test('wish 侧：封面 URL 由注入的 storage 拼（sort_order = 0）', async () => {
  await withOwners(async ({ ownerId, otherId }) => {
    const wishId = await createWish(ownerId)
    const listingId = await createListing(otherId)
    await db.insert(listingImages).values([
      { listingId, objectKey: 'listings/u/1.jpg', sortOrder: 1 },
      { listingId, objectKey: 'listings/u/0.jpg', sortOrder: 0 },
    ])
    await createMatch(listingId, wishId, 90)

    const response = await service.listByWish(ownerId, wishId, 10)

    expect(response.items[0]?.listing.coverUrl).toBe('https://cdn.test/listings/u/0.jpg')
  })
})

// 决策 C（#6）：一条脏数据不该让整个列表打不开。这里用超出契约上限的标题构造脏行。
test('wish 侧：无法映射为契约的卡片被跳过，但 total 仍计入', async () => {
  await withOwners(async ({ ownerId, otherId }) => {
    const wishId = await createWish(ownerId)
    const dirty = await createListing(otherId, { title: '超'.repeat(41) })
    const clean = await createListing(otherId)
    await createMatch(dirty, wishId, 99)
    await createMatch(clean, wishId, 90)

    const response = await service.listByWish(ownerId, wishId, 10)

    expect(response.total).toBe(2)
    expect(response.items.map((item) => item.listing.id)).toEqual([publicListing(clean)])
  })
})

// 商品被编辑后重算会把分数**覆盖**成新值（引擎侧：`apps/worker/src/jobs/matching/engine.ts`
// 对已掉出阈值/候选集的既有行也会重新打分；回归用例见那边的「改标题后掉出阈值」）。
// `matches` 行不删（契约 §5.3），所以读接口必须按阈值过滤，否则页面上会留一个"已经不该匹配"的卡片。
test('两个方向都过滤掉分数跌出阈值的旧匹配行（items 与 total 都不算）', async () => {
  await withOwners(async ({ ownerId, otherId }) => {
    const wishId = await createWish(ownerId)
    const listingId = await createListing(otherId)
    // 65 = 分类不符但关键词与价格满分：重算后的真实结果，已不够 70。
    await createMatch(listingId, wishId, 65)

    expect(await service.listByWish(ownerId, wishId, 10)).toEqual({ total: 0, items: [] })
    expect(await service.listByListing(otherId, listingId, 10)).toEqual({ total: 0, items: [] })
  })
})

test('listing 侧：只返回 ACTIVE 愿望，可空字段原样带出', async () => {
  await withOwners(async ({ ownerId, otherId }) => {
    const listingId = await createListing(ownerId)
    const openWish = await createWish(otherId, {
      category: null,
      budgetMinCents: null,
      budgetMaxCents: null,
    })
    const closedWish = await createWish(otherId, { status: 'CLOSED' })

    await createMatch(listingId, openWish, 88)
    await createMatch(listingId, closedWish, 99)

    const response = await service.listByListing(ownerId, listingId, 10)

    expect(response.total).toBe(1)
    expect(response.items).toHaveLength(1)
    expect(response.items[0]?.score).toBe(88)
    expect(response.items[0]?.wish).toEqual({
      id: publicWish(openWish),
      keyword: '机械键盘',
      category: null,
      budgetMinCents: null,
      budgetMaxCents: null,
    })
  })
})

test('不是本人的目标返回 403，不存在的目标返回 404', async () => {
  await withOwners(async ({ ownerId, otherId }) => {
    const wishId = await createWish(otherId)
    const listingId = await createListing(otherId)

    // 逐个 await：预先建出一堆 rejected promise 会变成未捕获拒绝。
    await expect(service.listByWish(ownerId, wishId, 10)).rejects.toMatchObject({
      status: 403,
      code: 'NOT_TARGET_OWNER',
    })
    await expect(service.listByListing(ownerId, listingId, 10)).rejects.toMatchObject({
      status: 403,
      code: 'NOT_TARGET_OWNER',
    })

    await expect(service.listByWish(ownerId, newId(), 10)).rejects.toBeInstanceOf(
      MatchingServiceError,
    )
    await expect(service.listByWish(ownerId, newId(), 10)).rejects.toMatchObject({
      status: 404,
      code: 'MATCH_TARGET_NOT_FOUND',
    })
    await expect(service.listByListing(ownerId, newId(), 10)).rejects.toMatchObject({
      status: 404,
      code: 'MATCH_TARGET_NOT_FOUND',
    })

    // 他人的 OFFLINE 商品按 404（与 #6 的"不泄漏存在性"同一口径）：返 403 就等于确认
    // "这个 id 存在且是别人的商品"。自己的 OFFLINE 商品仍然可读（下面这行不抛）。
    const offline = await createListing(otherId, { status: 'OFFLINE' })
    await expect(service.listByListing(ownerId, offline, 10)).rejects.toMatchObject({
      status: 404,
      code: 'MATCH_TARGET_NOT_FOUND',
    })
    await expect(service.listByListing(otherId, offline, 10)).resolves.toEqual({
      total: 0,
      items: [],
    })
  })
})

// tie-break：同分时按 `id DESC`（契约 §2.1）。UUIDv7 是时间有序的，所以"新的在前"是确定的。
// 没有这条断言的话，把 `orderBy` 写成非确定性实现也不会被发现。
test('同分时按 id 降序（稳定 tie-break）', async () => {
  await withOwners(async ({ ownerId, otherId }) => {
    const wishId = await createWish(ownerId)
    const first = await createListing(otherId)
    const second = await createListing(otherId)
    await createMatch(first, wishId, 90)
    await createMatch(second, wishId, 90)

    const response = await service.listByWish(ownerId, wishId, 10)

    const expected = [first, second].sort((a, b) => b.localeCompare(a))
    expect(response.items.map((item) => item.listing.id)).toEqual(expected.map(publicListing))
  })
})

// 读路径必须表达与引擎**同一条**价格可匹配性规则（§3.1 / 补记 §9.8）。
// 只按 `score >= 70` 过滤挡不住这种行：分类与关键词满分、价格超 2 倍时裸分恰好 70。
test('价格超出 2 倍预算的行在两个方向都不可见（裸分 70 也不行）', async () => {
  await withOwners(async ({ ownerId, otherId }) => {
    const wishId = await createWish(ownerId, { budgetMaxCents: 7000 })
    const tooExpensive = await createListing(otherId, { priceCents: 16000 })
    const affordable = await createListing(otherId, { priceCents: 6000 })
    await createMatch(tooExpensive, wishId, 70)
    await createMatch(affordable, wishId, 90)

    const wishSide = await service.listByWish(ownerId, wishId, 10)
    expect(wishSide.total).toBe(1)
    expect(wishSide.items.map((item) => item.listing.id)).toEqual([publicListing(affordable)])

    const listingSide = await service.listByListing(otherId, tooExpensive, 10)
    expect(listingSide).toEqual({ total: 0, items: [] })
  })
})

// listing 方向的 tie-break 与 wish 方向同一处实现，但读的是另一条 SQL，需要独立覆盖。
test('listing 方向同分时也按 id 降序', async () => {
  await withOwners(async ({ ownerId, otherId }) => {
    const listingId = await createListing(ownerId)
    const first = await createWish(otherId)
    const second = await createWish(otherId)
    await createMatch(listingId, first, 90)
    await createMatch(listingId, second, 90)

    const response = await service.listByListing(ownerId, listingId, 10)

    const expected = [first, second].sort((a, b) => b.localeCompare(a))
    expect(response.items.map((item) => item.wish.id)).toEqual(expected.map(publicWish))
  })
})

// 把 wish 侧的可见性策略钉住：RESERVED / SOLD 保留（卡片自带状态角标），只有 OFFLINE 隐藏。
// 这条策略与引擎计数同源（见 apps/worker 的 engine.test.ts 同名用例）。
test('wish 侧保留 RESERVED/SOLD 商品，只隐藏 OFFLINE', async () => {
  await withOwners(async ({ ownerId, otherId }) => {
    const wishId = await createWish(ownerId)
    const reserved = await createListing(otherId, { status: 'RESERVED' })
    const sold = await createListing(otherId, { status: 'SOLD' })
    const offline = await createListing(otherId, { status: 'OFFLINE' })
    await createMatch(reserved, wishId, 90)
    await createMatch(sold, wishId, 85)
    await createMatch(offline, wishId, 95)

    const response = await service.listByWish(ownerId, wishId, 10)

    expect(response.total).toBe(2)
    expect(response.items.map((item) => item.listing.status)).toEqual(['RESERVED', 'SOLD'])
  })
})

// 两个方向的可见性口径一致：只展示 ACTIVE 愿望的匹配（wish 侧同样过滤目标愿望的状态）。
test('wish 侧：愿望成真/关闭后不再返回匹配', async () => {
  await withOwners(async ({ ownerId, otherId }) => {
    const closed = await createWish(ownerId, { status: 'CLOSED' })
    const fulfilled = await createWish(ownerId, { status: 'FULFILLED' })
    await createMatch(await createListing(otherId), closed, 95)
    await createMatch(await createListing(otherId), fulfilled, 95)

    expect(await service.listByWish(ownerId, closed, 10)).toEqual({ total: 0, items: [] })
    expect(await service.listByWish(ownerId, fulfilled, 10)).toEqual({ total: 0, items: [] })
  })
})
