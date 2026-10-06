import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createDb, type Db } from './client'
import { newId } from './ids'
import {
  countListingImpressions,
  findCategoryRecallCandidates,
  findExploreRecallCandidates,
  findExposureHistory,
  findFreshRecallCandidates,
  findPopularRecallCandidates,
  findSemanticRecallCandidates,
  findSessionCategoryWeights,
  findVisibleListingRefs,
  findWishRecallCandidates,
} from './recall-store'
import { EMBEDDING_DIMENSIONS, embeddings } from './schema/embeddings'
import { listings } from './schema/listings'
import { matches } from './schema/matches'
import { recommendationEvents } from './schema/recommendation-events'
import { users } from './schema/users'
import { wishes } from './schema/wishes'
import { reserveTestListingNo } from './testing/listing-no'

/**
 * 六路召回的**商品侧查询**集成测试（#323 R3）。
 *
 * 打桩替代不了这一层：正确性几乎全在 SQL 里——可见性谓词、窗口起点、`LIMIT` 的位置、
 * `GROUP BY` 的聚合口径、`ORDER BY` 的并列处理。纯编排（降级、兴趣合成、合并去重）由
 * `apps/api/src/modules/recommendation/recall/*.test.ts` 覆盖，这里只断言"库里取出什么"。
 *
 * 权重表与半衰期**在用例里显式给出**，不从 `@fish/contracts` 引入：`packages/db` 不依赖 contracts，
 * 而且这里的断言关心的是"SQL 有没有正确使用传进来的数值"，不是"契约里的数值是多少"。
 */

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const migrationsFolder = Bun.fileURLToPath(new URL('./migrations', import.meta.url))
const scratchDatabase = `fish_recall_store_test_${process.pid}`
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

// 六路召回的商品侧查询都是**全库**查询（没有租户/批次维度），同一个 scratch 库里上一个用例
// 造的商品会落进下一个用例的窗口。逐用例清表比"把断言写宽"更值：断言才能保持精确。
beforeEach(async () => {
  await db.$client.unsafe(
    'truncate table recommendation_events, embeddings, matches, wishes, listings, users restart identity cascade',
  )
})

const MODEL = 'recall-store-test-model'
const OTHER_MODEL = 'recall-store-test-model-legacy'
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

let seq = 0

/** 1536 维单位向量：只有 `axis` 位是 1，手算 cosine 用。 */
function unitVector(axis: number): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0)
  vector[axis] = 1
  return vector
}

const X = unitVector(0)
const Y = unitVector(1)

async function createUser(options: { createdAt?: Date } = {}): Promise<string> {
  const rows = await db
    .insert(users)
    .values({
      studentNo: `recall-${Date.now()}-${seq++}`,
      passwordHash: 'test-not-a-real-hash',
      nickname: '召回测试用户',
      ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
    })
    .returning({ id: users.id })
  const row = rows[0]
  if (!row) throw new Error('insert users 未返回行')
  return row.id
}

type ListingOptions = {
  sellerId: string
  /** 显式指定 id：需要"插入顺序 ≠ id 顺序"的确定性用例用它（默认随机 uuidv7）。 */
  id?: string
  category?: (typeof listings.$inferInsert)['category']
  status?: (typeof listings.$inferInsert)['status']
  moderationStatus?: (typeof listings.$inferInsert)['moderationStatus']
  createdAt?: Date
}

async function createListing(
  options: ListingOptions,
): Promise<{ id: string; updatedAt: Date; createdAt: Date }> {
  const id = options.id ?? newId()
  const rows = await db
    .insert(listings)
    .values({
      id,
      listingNo: await reserveTestListingNo(db, id),
      sellerId: options.sellerId,
      title: `召回测试商品 ${seq++}`,
      description: '召回测试',
      priceCents: 100,
      category: options.category ?? 'OTHER',
      condition: 'GOOD',
      status: options.status ?? 'ACTIVE',
      moderationStatus: options.moderationStatus ?? 'APPROVED',
      ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
    })
    .returning({ updatedAt: listings.updatedAt, createdAt: listings.createdAt })
  const row = rows[0]
  if (!row) throw new Error('insert listings 未返回行')
  return { id, updatedAt: row.updatedAt, createdAt: row.createdAt }
}

async function putEmbedding(
  listingId: string,
  vector: number[],
  options: { model?: string; sourceUpdatedAt: Date },
): Promise<void> {
  await db.insert(embeddings).values({
    id: newId(),
    listingId,
    model: options.model ?? MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    contentHash: `hash-${seq++}`,
    embedding: vector,
    sourceUpdatedAt: options.sourceUpdatedAt,
  })
}

async function addEvent(input: {
  userId?: string | null
  anonymousSessionId?: string | null
  listingId: string
  eventType: (typeof recommendationEvents.$inferInsert)['eventType']
  occurredAt: Date
  requestId?: string
  position?: number
}): Promise<void> {
  // 曝光类事件受 `recommendation_events_impression_requires_attribution` 约束：必须带
  // requestId + position。这里给一个随机 requestId（`request_id` 刻意没有外键），
  // 顺带避开 `(request_id, listing_id, event_type)` 的部分唯一索引。
  const needsAttribution = input.eventType === 'IMPRESSION' || input.eventType === 'QUICK_SKIP'
  await db.insert(recommendationEvents).values({
    id: newId(),
    eventId: newId(),
    userId: input.userId ?? null,
    anonymousSessionId: input.anonymousSessionId ?? null,
    requestId: input.requestId ?? (needsAttribution ? newId() : null),
    listingId: input.listingId,
    eventType: input.eventType,
    position: input.position ?? (needsAttribution ? 0 : null),
    occurredAt: input.occurredAt,
  })
}

async function createWish(input: {
  userId: string
  category?: (typeof wishes.$inferInsert)['category']
  status?: (typeof wishes.$inferInsert)['status']
}): Promise<string> {
  const rows = await db
    .insert(wishes)
    .values({
      userId: input.userId,
      keyword: `愿望 ${seq++}`,
      ...(input.category === undefined ? {} : { category: input.category }),
      ...(input.status === undefined ? {} : { status: input.status }),
    })
    .returning({ id: wishes.id })
  const row = rows[0]
  if (!row) throw new Error('insert wishes 未返回行')
  return row.id
}

async function addMatch(input: {
  listingId: string
  wishId: string
  score: number
}): Promise<void> {
  await db.insert(matches).values({
    listingId: input.listingId,
    wishId: input.wishId,
    score: input.score,
    categoryScore: 0,
    keywordScore: 0,
    priceScore: 0,
  })
}

const ids = (rows: readonly { listingId: string }[]) => rows.map((row) => row.listingId)

describe('findFreshRecallCandidates', () => {
  test('只返回可见商品、按发布时间倒序、排除本人商品、尊重 limit', async () => {
    const seller = await createUser()
    const viewer = await createUser()
    const now = new Date()

    const old = await createListing({
      sellerId: seller,
      createdAt: new Date(now.getTime() - 3 * DAY),
    })
    const fresh = await createListing({
      sellerId: seller,
      createdAt: new Date(now.getTime() - 1 * DAY),
    })
    const sold = await createListing({ sellerId: seller, status: 'SOLD' })
    const reserved = await createListing({ sellerId: seller, status: 'RESERVED' })
    const offline = await createListing({ sellerId: seller, status: 'OFFLINE' })
    const review = await createListing({ sellerId: seller, moderationStatus: 'REVIEW' })

    const rows = await findFreshRecallCandidates(db, { limit: 10, viewerUserId: viewer })
    expect(ids(rows)).toEqual([fresh.id, old.id])

    // 本人商品不进候选（"本人商品过滤"是召回层就要满足的硬约束）。
    const own = await findFreshRecallCandidates(db, { limit: 10, viewerUserId: seller })
    expect(ids(own)).toEqual([])

    // limit 生效在 SQL 侧：取 1 条就是最新那条，不是"取 10 条再切片"。
    const limited = await findFreshRecallCandidates(db, { limit: 1, viewerUserId: viewer })
    expect(ids(limited)).toEqual([fresh.id])

    for (const excluded of [sold, reserved, offline, review]) {
      expect(ids(rows)).not.toContain(excluded.id)
    }
  })
})

describe('findPopularRecallCandidates', () => {
  test('按行为权重 × 行为衰减 × 商品年龄衰减排序，窗口外与零权行为不计', async () => {
    const seller = await createUser()
    const viewer = await createUser()
    const now = new Date('2026-01-15T12:00:00.000Z')
    const weights = [
      { eventType: 'DETAIL_VIEW' as const, weight: 1 },
      { eventType: 'FAVORITE' as const, weight: 3 },
    ]

    // 商品创建时刻 = now：年龄衰减因子恰好是 1，断言能直接落在行为项上。
    const hot = await createListing({ sellerId: seller, createdAt: now })
    const oldFavorite = await createListing({ sellerId: seller, createdAt: now })
    const impressionOnly = await createListing({ sellerId: seller, createdAt: now })
    const outsideWindow = await createListing({ sellerId: seller, createdAt: now })

    for (let index = 0; index < 3; index += 1) {
      await addEvent({
        userId: viewer,
        listingId: hot.id,
        eventType: 'DETAIL_VIEW',
        occurredAt: new Date(now.getTime() - DAY),
      })
    }
    await addEvent({
      userId: viewer,
      listingId: oldFavorite.id,
      eventType: 'FAVORITE',
      occurredAt: new Date(now.getTime() - 10 * DAY),
    })
    await addEvent({
      userId: viewer,
      listingId: impressionOnly.id,
      eventType: 'IMPRESSION',
      occurredAt: new Date(now.getTime() - HOUR),
    })
    await addEvent({
      userId: viewer,
      listingId: outsideWindow.id,
      eventType: 'DETAIL_VIEW',
      occurredAt: new Date(now.getTime() - 20 * DAY),
    })

    const rows = await findPopularRecallCandidates(db, {
      limit: 10,
      viewerUserId: null,
      windowStart: new Date(now.getTime() - 14 * DAY),
      now,
      weights,
      actionHalfLifeMs: 3 * DAY,
      listingAgeHalfLifeMs: 7 * DAY,
    })

    expect(ids(rows)).toEqual([hot.id, oldFavorite.id])
    expect(rows[0]?.popularity).toBeCloseTo(3 * 0.5 ** (1 / 3), 6)
    expect(rows[1]?.popularity).toBeCloseTo(3 * 0.5 ** (10 / 3), 6)
  })

  test('商品年龄衰减把"老爆款"压下去（同样的行为量，新商品排前面）', async () => {
    const seller = await createUser()
    const now = new Date('2026-01-15T12:00:00.000Z')
    const weights = [{ eventType: 'DETAIL_VIEW' as const, weight: 1 }]

    const brandNew = await createListing({ sellerId: seller, createdAt: now })
    const ancient = await createListing({
      sellerId: seller,
      createdAt: new Date(now.getTime() - 60 * DAY),
    })
    for (const listingId of [brandNew.id, ancient.id]) {
      await addEvent({
        userId: null,
        anonymousSessionId: newId(),
        listingId,
        eventType: 'DETAIL_VIEW',
        occurredAt: new Date(now.getTime() - DAY),
      })
    }

    const rows = await findPopularRecallCandidates(db, {
      limit: 10,
      viewerUserId: null,
      windowStart: new Date(now.getTime() - 14 * DAY),
      now,
      weights,
      actionHalfLifeMs: 3 * DAY,
      listingAgeHalfLifeMs: 7 * DAY,
    })

    expect(ids(rows)).toEqual([brandNew.id, ancient.id])
    expect(rows[1]?.popularity).toBeCloseTo(0.5 ** (1 / 3) * 0.5 ** (60 / 7), 6)
  })
})

describe('findSemanticRecallCandidates', () => {
  test('按 cosine 距离排序，只认当前模型的新鲜向量，并排除不可见商品', async () => {
    const seller = await createUser()
    const viewer = await createUser()

    const sameDirection = await createListing({ sellerId: seller })
    await putEmbedding(sameDirection.id, X, { sourceUpdatedAt: sameDirection.updatedAt })
    const orthogonal = await createListing({ sellerId: seller })
    await putEmbedding(orthogonal.id, Y, { sourceUpdatedAt: orthogonal.updatedAt })

    // 三种"向量不可用"：换过模型、向量落后于商品编辑、商品已不可见。
    const otherModel = await createListing({ sellerId: seller })
    await putEmbedding(otherModel.id, X, {
      model: OTHER_MODEL,
      sourceUpdatedAt: otherModel.updatedAt,
    })
    const stale = await createListing({ sellerId: seller })
    await putEmbedding(stale.id, X, {
      sourceUpdatedAt: new Date(stale.updatedAt.getTime() - 1000),
    })
    const sold = await createListing({ sellerId: seller, status: 'SOLD' })
    await putEmbedding(sold.id, X, { sourceUpdatedAt: sold.updatedAt })

    const rows = await findSemanticRecallCandidates(db, {
      vector: X,
      model: MODEL,
      limit: 10,
      viewerUserId: viewer,
    })

    expect(ids(rows)).toEqual([sameDirection.id, orthogonal.id])
    expect(rows[0]?.semanticScore).toBeCloseTo(1, 6)
    expect(rows[1]?.semanticScore).toBeCloseTo(0, 6)

    const limited = await findSemanticRecallCandidates(db, {
      vector: X,
      model: MODEL,
      limit: 1,
      viewerUserId: viewer,
    })
    expect(ids(limited)).toEqual([sameDirection.id])
  })

  test('距离并列时按 id 兜底：Top-K 集合与插入顺序无关（验收项 9 同输入可复现）', async () => {
    const seller = await createUser()
    const viewer = await createUser()

    // 六个 id 递增的商品，**按 id 降序插入**：堆内物理顺序与 id 序相反。
    // 没有次键时 `ORDER BY 距离 LIMIT 3` 会取到"先插入的三行"（id 最大的三条），
    // 有次键时必须稳定取 id 最小的三条——这正是"候选集合可复现"。
    const listingIds = [newId(), newId(), newId(), newId(), newId(), newId()].sort()
    for (const id of [...listingIds].reverse()) {
      const listing = await createListing({ sellerId: seller, id })
      await putEmbedding(id, X, { sourceUpdatedAt: listing.updatedAt })
    }

    const rows = await findSemanticRecallCandidates(db, {
      vector: X,
      model: MODEL,
      limit: 3,
      viewerUserId: viewer,
    })

    expect(ids(rows)).toEqual(listingIds.slice(0, 3))
  })
})

describe('findWishRecallCandidates', () => {
  test('只取本人 ACTIVE 愿望的匹配，同一商品多愿望命中只留最高分', async () => {
    const seller = await createUser()
    const wishOwner = await createUser()
    const otherUser = await createUser()

    const first = await createListing({ sellerId: seller })
    const second = await createListing({ sellerId: seller })
    const sold = await createListing({ sellerId: seller, status: 'SOLD' })
    const foreign = await createListing({ sellerId: seller })

    const wishA = await createWish({ userId: wishOwner })
    const wishB = await createWish({ userId: wishOwner })
    const closedWish = await createWish({ userId: wishOwner, status: 'CLOSED' })
    const otherWish = await createWish({ userId: otherUser })

    await addMatch({ listingId: first.id, wishId: wishA, score: 50 })
    await addMatch({ listingId: first.id, wishId: wishB, score: 80 })
    await addMatch({ listingId: second.id, wishId: wishA, score: 60 })
    await addMatch({ listingId: sold.id, wishId: wishA, score: 99 })
    await addMatch({ listingId: foreign.id, wishId: otherWish, score: 95 })
    await addMatch({ listingId: foreign.id, wishId: closedWish, score: 98 })

    const rows = await findWishRecallCandidates(db, { userId: wishOwner, limit: 10 })

    // first 同时命中两个愿望 → 只留最高分 80（同一 listing 只能是一个 candidate）。
    expect(rows.map((row) => [row.listingId, row.wishScore])).toEqual([
      [first.id, 80],
      [second.id, 60],
    ])
  })
})

describe('findCategoryRecallCandidates', () => {
  test('按传入类目顺序取候选，每类目限流，类目内按发布时间倒序', async () => {
    const seller = await createUser()
    const viewer = await createUser()
    const now = new Date()

    const booksNew = await createListing({
      sellerId: seller,
      category: 'BOOKS',
      createdAt: new Date(now.getTime() - 1 * DAY),
    })
    await createListing({
      sellerId: seller,
      category: 'BOOKS',
      createdAt: new Date(now.getTime() - 2 * DAY),
    })
    const digital = await createListing({ sellerId: seller, category: 'DIGITAL' })
    const soldBook = await createListing({ sellerId: seller, category: 'BOOKS', status: 'SOLD' })

    const rows = await findCategoryRecallCandidates(db, {
      categories: ['BOOKS', 'DIGITAL'],
      perCategoryLimit: 1,
      viewerUserId: viewer,
    })

    expect(ids(rows)).toEqual([booksNew.id, digital.id])
    expect(ids(rows)).not.toContain(soldBook.id)

    const bothBooks = await findCategoryRecallCandidates(db, {
      categories: ['BOOKS'],
      perCategoryLimit: 2,
      viewerUserId: viewer,
    })
    expect(bothBooks[0]?.listingId).toBe(booksNew.id)
    expect(bothBooks).toHaveLength(2)
  })
})

describe('findExploreRecallCandidates', () => {
  test('新商品 / 新卖家 / 冷门类目三块，去重后空位让给新商品', async () => {
    const viewer = await createUser()
    const now = new Date()
    const newSeller = await createUser({ createdAt: new Date(now.getTime() - 2 * DAY) })
    const oldSeller = await createUser({ createdAt: new Date(now.getTime() - 200 * DAY) })

    // 新卖家 + 新商品（同一件商品同时命中两块：去重后只能出现一次）。
    const both = await createListing({
      sellerId: newSeller,
      category: 'BOOKS',
      createdAt: new Date(now.getTime() - 1 * DAY),
    })
    // 老卖家的新商品：只命中"新商品"。
    const newListing = await createListing({
      sellerId: oldSeller,
      category: 'DAILY',
      createdAt: new Date(now.getTime() - 2 * DAY),
    })
    // 老卖家的老商品 + 冷门类目：只命中"冷门类目"。
    const cold = await createListing({
      sellerId: oldSeller,
      category: 'SPORTS',
      createdAt: new Date(now.getTime() - 100 * DAY),
    })
    // 老卖家的老商品、非冷门类目：三块都不命中。
    await createListing({
      sellerId: oldSeller,
      category: 'DIGITAL',
      createdAt: new Date(now.getTime() - 100 * DAY),
    })

    const rows = await findExploreRecallCandidates(db, {
      limit: 10,
      newListingLimit: 2,
      newSellerLimit: 2,
      coldCategoryLimit: 1,
      newListingWindowStart: new Date(now.getTime() - 3 * DAY),
      newSellerWindowStart: new Date(now.getTime() - 30 * DAY),
      coldCategories: ['SPORTS'],
      viewerUserId: viewer,
    })

    const bySubSource = rows.map((row) => [row.listingId, row.subSource])
    expect(bySubSource).toEqual([
      [both.id, 'new_listing'],
      [newListing.id, 'new_listing'],
      [cold.id, 'cold_category'],
    ])
    // 去重：`both` 同时是新商品与新卖家的商品，只出现一次。
    expect(new Set(ids(rows)).size).toBe(rows.length)
  })

  test('新商品块配额用尽后，空位由后续新商品补上（不让探索位空着）', async () => {
    const viewer = await createUser()
    const seller = await createUser({ createdAt: new Date(Date.now() - 200 * DAY) })
    const now = new Date()
    const created: string[] = []
    for (let index = 0; index < 3; index += 1) {
      const listing = await createListing({
        sellerId: seller,
        category: 'DIGITAL',
        createdAt: new Date(now.getTime() - (index + 1) * HOUR),
      })
      created.push(listing.id)
    }

    const rows = await findExploreRecallCandidates(db, {
      limit: 3,
      newListingLimit: 1,
      newSellerLimit: 0,
      coldCategoryLimit: 0,
      newListingWindowStart: new Date(now.getTime() - 3 * DAY),
      newSellerWindowStart: new Date(now.getTime() - 30 * DAY),
      coldCategories: [],
      viewerUserId: viewer,
    })

    // 配额 1 + 空位补 2 = 全部 3 件新商品，且都是 new_listing。
    expect(ids(rows)).toEqual(created)
    expect(rows.every((row) => row.subSource === 'new_listing')).toBe(true)
  })
})

describe('findVisibleListingRefs', () => {
  test('返回卖家/类目/发布时间，且只包含此刻仍可见的商品', async () => {
    const seller = await createUser()
    const now = new Date()
    const visible = await createListing({
      sellerId: seller,
      category: 'BOOKS',
      createdAt: new Date(now.getTime() - DAY),
    })
    const sold = await createListing({ sellerId: seller, status: 'SOLD' })

    const rows = await findVisibleListingRefs(db, {
      listingIds: [visible.id, sold.id, newId()],
      viewerUserId: null,
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]?.listingId).toBe(visible.id)
    expect(rows[0]?.sellerId).toBe(seller)
    expect(rows[0]?.category).toBe('BOOKS')
    expect(rows[0]?.createdAt.getTime()).toBe(visible.createdAt.getTime())
  })

  test('本人商品在复核里也算不可见', async () => {
    const seller = await createUser()
    const listing = await createListing({ sellerId: seller })

    expect(
      await findVisibleListingRefs(db, { listingIds: [listing.id], viewerUserId: seller }),
    ).toEqual([])
  })
})

describe('countListingImpressions', () => {
  test('只数 IMPRESSION，且匿名身份必须 user_id 为空', async () => {
    const seller = await createUser()
    const user = await createUser()
    const listing = await createListing({ sellerId: seller })
    const now = new Date()

    await addEvent({
      userId: user,
      listingId: listing.id,
      eventType: 'IMPRESSION',
      occurredAt: now,
    })
    await addEvent({
      userId: user,
      listingId: listing.id,
      eventType: 'IMPRESSION',
      occurredAt: now,
    })
    // 同一商品的其他事件类型不计数。
    await addEvent({
      userId: user,
      listingId: listing.id,
      eventType: 'DETAIL_VIEW',
      occurredAt: now,
    })

    const session = newId()
    await addEvent({
      anonymousSessionId: session,
      listingId: listing.id,
      eventType: 'IMPRESSION',
      occurredAt: now,
    })
    // 同一会话 id 但已登录：属于用户身份，不能算进匿名身份的次数。
    await addEvent({
      userId: user,
      anonymousSessionId: session,
      listingId: listing.id,
      eventType: 'IMPRESSION',
      occurredAt: now,
    })

    const userRows = await countListingImpressions(db, {
      listingIds: [listing.id],
      identity: { kind: 'user', id: user },
    })
    expect(userRows).toEqual([{ listingId: listing.id, count: 3 }])

    const anonymousRows = await countListingImpressions(db, {
      listingIds: [listing.id],
      identity: { kind: 'anonymous', id: session },
    })
    expect(anonymousRows).toEqual([{ listingId: listing.id, count: 1 }])
  })
})

describe('findExposureHistory', () => {
  /** 只传两个互动类型，用来证明"不在集合里的事件类型两个聚合都不计"。 */
  const ENGAGEMENT = ['DETAIL_VIEW', 'FAVORITE'] as const

  test('三类聚合：曝光次数、最后一次曝光时间、互动次数；不在集合里的类型不计', async () => {
    const seller = await createUser()
    const user = await createUser()
    const listing = await createListing({ sellerId: seller })
    const other = await createListing({ sellerId: seller })
    const earlier = new Date('2026-01-15T10:00:00.000Z')
    const later = new Date('2026-01-15T12:00:00.000Z')

    await addEvent({
      userId: user,
      listingId: listing.id,
      eventType: 'IMPRESSION',
      occurredAt: earlier,
    })
    await addEvent({
      userId: user,
      listingId: listing.id,
      eventType: 'IMPRESSION',
      occurredAt: later,
    })
    await addEvent({
      userId: user,
      listingId: listing.id,
      eventType: 'FAVORITE',
      occurredAt: later,
    })
    // `QUICK_SKIP` 既不是 IMPRESSION 也不在 ENGAGEMENT 里 ⇒ 两个聚合都不该计（M6：划过 ≠ 点过）。
    await addEvent({
      userId: user,
      listingId: listing.id,
      eventType: 'QUICK_SKIP',
      occurredAt: later,
    })
    // 另一件商品只有互动、没有曝光：`lastExposedAt` 必须是 null 而不是"被互动时间顶上来"。
    await addEvent({
      userId: user,
      listingId: other.id,
      eventType: 'DETAIL_VIEW',
      occurredAt: later,
    })

    const rows = await findExposureHistory(db, {
      listingIds: [listing.id, other.id],
      identity: { kind: 'user', id: user },
      engagementEventTypes: [...ENGAGEMENT],
    })

    const byListing = new Map(rows.map((row) => [row.listingId, row]))
    expect(byListing.get(listing.id)).toEqual({
      listingId: listing.id,
      exposureCount: 2,
      lastExposedAt: later,
      engagedCount: 1,
    })
    expect(byListing.get(other.id)).toEqual({
      listingId: other.id,
      exposureCount: 0,
      lastExposedAt: null,
      engagedCount: 1,
    })
  })

  test('身份隔离：匿名身份只算 `user_id` 为空的事件（同会话 id 的已登录事件归用户）', async () => {
    const seller = await createUser()
    const user = await createUser()
    const listing = await createListing({ sellerId: seller })
    const session = newId()
    const now = new Date('2026-01-15T10:00:00.000Z')

    await addEvent({
      anonymousSessionId: session,
      listingId: listing.id,
      eventType: 'IMPRESSION',
      occurredAt: now,
    })
    await addEvent({
      anonymousSessionId: session,
      listingId: listing.id,
      eventType: 'IMPRESSION',
      occurredAt: now,
    })
    await addEvent({
      userId: user,
      anonymousSessionId: session,
      listingId: listing.id,
      eventType: 'IMPRESSION',
      occurredAt: now,
    })

    expect(
      await findExposureHistory(db, {
        listingIds: [listing.id],
        identity: { kind: 'anonymous', id: session },
        engagementEventTypes: [...ENGAGEMENT],
      }),
    ).toEqual([{ listingId: listing.id, exposureCount: 2, lastExposedAt: now, engagedCount: 0 }])
    expect(
      await findExposureHistory(db, {
        listingIds: [listing.id],
        identity: { kind: 'user', id: user },
        engagementEventTypes: [...ENGAGEMENT],
      }),
    ).toEqual([{ listingId: listing.id, exposureCount: 1, lastExposedAt: now, engagedCount: 0 }])
  })

  test('空候选集直接返回空数组（不发查询）', async () => {
    expect(
      await findExposureHistory(db, {
        listingIds: [],
        identity: { kind: 'anonymous', id: newId() },
        engagementEventTypes: [...ENGAGEMENT],
      }),
    ).toEqual([])
  })
})

describe('findSessionCategoryWeights', () => {
  test('按类目汇总衰减权重，零权事件不计，负权可以抵消', async () => {
    const user = await createUser()
    const seller = await createUser()
    const now = new Date('2026-01-15T12:00:00.000Z')
    const weights = [
      { eventType: 'DETAIL_VIEW' as const, weight: 1 },
      { eventType: 'FAVORITE' as const, weight: 4 },
      { eventType: 'HIDE' as const, weight: -3 },
    ]

    const books = await createListing({ sellerId: seller, category: 'BOOKS' })
    const digital = await createListing({ sellerId: seller, category: 'DIGITAL' })

    await addEvent({
      userId: user,
      listingId: books.id,
      eventType: 'FAVORITE',
      occurredAt: now,
    })
    await addEvent({
      userId: user,
      listingId: digital.id,
      eventType: 'DETAIL_VIEW',
      occurredAt: new Date(now.getTime() - 30 * MINUTE),
    })
    await addEvent({
      userId: user,
      listingId: digital.id,
      eventType: 'HIDE',
      occurredAt: now,
    })
    // 零权事件（曝光）既不计权重也不占条数窗。
    await addEvent({
      userId: user,
      listingId: books.id,
      eventType: 'IMPRESSION',
      occurredAt: now,
    })

    const rows = await findSessionCategoryWeights(db, {
      identity: { kind: 'user', id: user },
      since: new Date(now.getTime() - 180 * DAY),
      now,
      limit: 50,
      zeroWeightEventTypes: ['IMPRESSION'],
      weights,
      halfLifeMs: 30 * MINUTE,
    })

    const byCategory = new Map(rows.map((row) => [row.category, row]))
    expect(byCategory.get('BOOKS')?.weight).toBeCloseTo(4, 6)
    // 30 分钟半衰期 → 恰好衰减一半；HIDE 的 -3 在同一类目上抵消。
    expect(byCategory.get('DIGITAL')?.weight).toBeCloseTo(0.5 - 3, 6)
  })

  test('条数窗在聚合前生效：只取窗口内最近的 N 条行为', async () => {
    const user = await createUser()
    const seller = await createUser()
    const now = new Date('2026-01-15T12:00:00.000Z')

    const books = await createListing({ sellerId: seller, category: 'BOOKS' })
    const digital = await createListing({ sellerId: seller, category: 'DIGITAL' })

    // 更早的一条 BOOKS 行为 + 更晚的一条 DIGITAL 行为，limit = 1 时只剩后者。
    await addEvent({
      userId: user,
      listingId: books.id,
      eventType: 'DETAIL_VIEW',
      occurredAt: new Date(now.getTime() - 2 * MINUTE),
    })
    await addEvent({
      userId: user,
      listingId: digital.id,
      eventType: 'DETAIL_VIEW',
      occurredAt: new Date(now.getTime() - 1 * MINUTE),
    })

    const rows = await findSessionCategoryWeights(db, {
      identity: { kind: 'user', id: user },
      since: new Date(now.getTime() - 180 * DAY),
      now,
      limit: 1,
      zeroWeightEventTypes: ['IMPRESSION'],
      weights: [{ eventType: 'DETAIL_VIEW', weight: 1 }],
      halfLifeMs: 30 * MINUTE,
    })

    expect(rows.map((row) => row.category)).toEqual(['DIGITAL'])
  })

  test('匿名身份不串到登录用户的行为上', async () => {
    const user = await createUser()
    const seller = await createUser()
    const now = new Date()
    const books = await createListing({ sellerId: seller, category: 'BOOKS' })
    const session = newId()

    await addEvent({
      userId: user,
      anonymousSessionId: session,
      listingId: books.id,
      eventType: 'FAVORITE',
      occurredAt: now,
    })

    const rows = await findSessionCategoryWeights(db, {
      identity: { kind: 'anonymous', id: session },
      since: new Date(now.getTime() - 180 * DAY),
      now,
      limit: 50,
      zeroWeightEventTypes: ['IMPRESSION'],
      weights: [{ eventType: 'FAVORITE', weight: 4 }],
      halfLifeMs: 30 * MINUTE,
    })

    expect(rows).toEqual([])
  })
})
