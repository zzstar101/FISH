import { afterAll, expect, test } from 'bun:test'
import { createDb } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { listingImages, listings } from '@fish/db/schema/listings'
import { matches } from '@fish/db/schema/matches'
import { users } from '@fish/db/schema/users'
import { wishes } from '@fish/db/schema/wishes'
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
    expect(response.items.map((item) => item.listing.id)).toEqual([higher, lower])
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
    expect(response.items.map((item) => item.listing.id)).toEqual([clean])
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
      id: openWish,
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
  })
})
