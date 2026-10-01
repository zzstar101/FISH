/**
 * R3 多路召回**编排层**集成测试（Issue #323 M2/M3）。
 *
 * 覆盖的是"六路怎么串起来"这件事：兴趣怎么给 semantic、哪一路该降级、降级原因怎么记账、
 * 最终可见性复核有没有兜住、合并后的 feature 对不对。SQL 本身的正确性由
 * `packages/db/src/recall-store.test.ts` 覆盖，纯合并逻辑由 `./merge.test.ts` 覆盖——
 * 这里不重复断言"距离怎么算"，只断言"编排有没有把这些零件接对"。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { createDb, type Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { EMBEDDING_DIMENSIONS, embeddings } from '@fish/db/schema/embeddings'
import { listings } from '@fish/db/schema/listings'
import { matches } from '@fish/db/schema/matches'
import { recommendationEvents } from '@fish/db/schema/recommendation-events'
import { userInterestProfiles } from '@fish/db/schema/user-interest-profiles'
import { users } from '@fish/db/schema/users'
import { wishes } from '@fish/db/schema/wishes'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createRecommendationRecall } from './service'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../../../../packages/db/src/migrations', import.meta.url),
)

const scratchDatabase = `fish_recall_service_test_${process.pid}`
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

// 六路召回没有租户维度，用例之间必须清表，否则上一个用例造的商品会落进下一个用例的窗口。
beforeEach(async () => {
  await db.$client.unsafe(
    'truncate table recommendation_events, embeddings, matches, wishes, user_interest_profiles, listings, users restart identity cascade',
  )
})

const MODEL = 'recall-service-test-model'
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

let seq = 0

/** 只有 `axis` 位为 1 的单位向量，手算 cosine 用。 */
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
      studentNo: `recall-svc-${Date.now()}-${seq++}`,
      passwordHash: 'test-not-a-real-hash',
      nickname: '召回编排测试用户',
      ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
    })
    .returning({ id: users.id })
  const row = rows[0]
  if (!row) throw new Error('insert users 未返回行')
  return row.id
}

type ListingOptions = {
  sellerId: string
  category?: (typeof listings.$inferInsert)['category']
  status?: (typeof listings.$inferInsert)['status']
  createdAt?: Date
}

async function createListing(options: ListingOptions): Promise<{ id: string; updatedAt: Date }> {
  const id = newId()
  const rows = await db
    .insert(listings)
    .values({
      id,
      listingNo: await reserveTestListingNo(db, id),
      sellerId: options.sellerId,
      title: `召回编排商品 ${seq++}`,
      description: '召回编排测试',
      priceCents: 100,
      category: options.category ?? 'OTHER',
      condition: 'GOOD',
      status: options.status ?? 'ACTIVE',
      ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
    })
    .returning({ updatedAt: listings.updatedAt })
  const row = rows[0]
  if (!row) throw new Error('insert listings 未返回行')
  return { id, updatedAt: row.updatedAt }
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
}): Promise<void> {
  const needsAttribution = input.eventType === 'IMPRESSION' || input.eventType === 'QUICK_SKIP'
  await db.insert(recommendationEvents).values({
    id: newId(),
    eventId: newId(),
    userId: input.userId ?? null,
    anonymousSessionId: input.anonymousSessionId ?? null,
    requestId: needsAttribution ? newId() : null,
    listingId: input.listingId,
    eventType: input.eventType,
    position: needsAttribution ? 0 : null,
    occurredAt: input.occurredAt,
  })
}

async function createWish(userId: string): Promise<string> {
  const rows = await db
    .insert(wishes)
    .values({ userId, keyword: `愿望 ${seq++}` })
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

async function putInterestProfile(input: {
  userId: string
  embedding: number[]
  strategyVersion?: string
  actionCount?: number
  computedAt?: Date
}): Promise<void> {
  await db.insert(userInterestProfiles).values({
    userId: input.userId,
    model: MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    strategyVersion: input.strategyVersion ?? 'interest-v1',
    embedding: input.embedding,
    actionCount: input.actionCount ?? 3,
    windowStartedAt: new Date(Date.now() - DAY),
    computedAt: input.computedAt ?? new Date(),
  })
}

const recall = () => createRecommendationRecall({ db, embeddingModel: MODEL })

const findCandidate = (
  candidates: readonly { listingId: string }[],
  listingId: string,
): { listingId: string; recallSources: string[] } | undefined =>
  candidates.find((candidate) => candidate.listingId === listingId) as
    | { listingId: string; recallSources: string[] }
    | undefined

describe('createRecommendationRecall 编排', () => {
  test('六路顺序固定，各通道候选可独立对账，合并去重后保留所有来源', async () => {
    const viewer = await createUser()
    const seller = await createUser()
    const now = new Date()

    // semantic 需要"兴趣向量 ↔ 商品向量"都新鲜：行为商品的 embedding 必须与商品 updated_at 同刻。
    const semanticTarget = await createListing({ sellerId: seller, category: 'BOOKS' })
    await putEmbedding(semanticTarget.id, X, { sourceUpdatedAt: semanticTarget.updatedAt })
    await addEvent({
      userId: viewer,
      listingId: semanticTarget.id,
      eventType: 'DETAIL_VIEW',
      occurredAt: new Date(now.getTime() - 30 * MINUTE),
    })

    const trending = await createListing({ sellerId: seller, category: 'DIGITAL' })
    await addEvent({
      userId: viewer,
      listingId: trending.id,
      eventType: 'FAVORITE',
      occurredAt: new Date(now.getTime() - HOUR),
    })

    const wished = await createListing({ sellerId: seller, category: 'DAILY' })
    const wishId = await createWish(viewer)
    await addMatch({ listingId: wished.id, wishId, score: 77 })

    const freshOnly = await createListing({ sellerId: seller, category: 'SPORTS' })
    const sold = await createListing({ sellerId: seller, category: 'BOOKS', status: 'SOLD' })
    await putEmbedding(sold.id, X, { sourceUpdatedAt: sold.updatedAt })

    const result = await recall().recall({ userId: viewer, anonymousSessionId: null })

    expect(result.strategyVersion).toBe('recall-v1')
    expect(result.channels.map((channel) => channel.channel)).toEqual([
      'fresh',
      'popular',
      'semantic',
      'wish',
      'category',
      'explore',
    ])
    for (const channel of result.channels) {
      expect(channel.degradedReason).toBeNull()
    }

    expect(result.interest).toEqual({ session: true, longTerm: false, combined: true })

    // semanticTarget 同时命中 semantic（有新鲜向量）与 category（BOOKS 是会话兴趣类目）：
    // 合并后必须两个 source 都在，且 feature 来自各自通道。
    const merged = findCandidate(result.candidates, semanticTarget.id)
    expect(merged?.recallSources).toContain('semantic')
    expect(merged?.recallSources).toContain('category')

    expect(findCandidate(result.candidates, trending.id)?.recallSources).toContain('popular')
    expect(findCandidate(result.candidates, wished.id)?.recallSources).toContain('wish')
    expect(findCandidate(result.candidates, freshOnly.id)?.recallSources).toContain('fresh')

    // 不可见商品在最终复核里被剔除（SOLD 商品即使有新鲜向量也不返回）。
    expect(result.candidates.map((candidate) => candidate.listingId)).not.toContain(sold.id)
    // 本人商品不返回（viewer 在这里同时是买家）。
    const ownListing = await createListing({ sellerId: viewer, category: 'OTHER' })
    const second = await recall().recall({ userId: viewer, anonymousSessionId: null })
    expect(second.candidates.map((candidate) => candidate.listingId)).not.toContain(ownListing.id)
  })

  test('合并后的候选带齐 M3 字段：来源、feature、类目亲和、曝光次数、卖家曝光', async () => {
    const viewer = await createUser()
    const seller = await createUser()
    const now = new Date()

    const first = await createListing({ sellerId: seller, category: 'BOOKS' })
    const second = await createListing({ sellerId: seller, category: 'BOOKS' })
    await putEmbedding(first.id, X, { sourceUpdatedAt: first.updatedAt })
    await addEvent({
      userId: viewer,
      listingId: first.id,
      eventType: 'DETAIL_VIEW',
      occurredAt: new Date(now.getTime() - 5 * MINUTE),
    })

    // 同一身份对 first 曝光两次：alreadySeenCount 应按身份累计。
    await addEvent({
      userId: viewer,
      listingId: first.id,
      eventType: 'IMPRESSION',
      occurredAt: new Date(now.getTime() - 10 * MINUTE),
    })
    await addEvent({
      userId: viewer,
      listingId: first.id,
      eventType: 'IMPRESSION',
      occurredAt: new Date(now.getTime() - 9 * MINUTE),
    })

    const result = await recall().recall({ userId: viewer, anonymousSessionId: null })

    const candidate = result.candidates.find((row) => row.listingId === first.id)
    expect(candidate).toBeDefined()
    expect(candidate?.sellerId).toBe(seller)
    expect(candidate?.category).toBe('BOOKS')
    expect(candidate?.alreadySeenCount).toBe(2)
    expect(candidate?.sellerExposure).toBe(2)
    expect(candidate?.semanticScore).toBeCloseTo(1, 6)
    // BOOKS 是唯一的正权类目 → 归一化亲和为 1；freshness 用商品年龄算，刚发布 ≈ 1。
    expect(candidate?.userCategoryAffinity).toBeCloseTo(1, 6)
    expect(candidate?.freshness).toBeGreaterThan(0.99)
    expect(candidate?.createdAt).toBeInstanceOf(Date)

    const other = result.candidates.find((row) => row.listingId === second.id)
    expect(other?.sellerExposure).toBe(2)
  })

  test('模型不可用：只降级 semantic；category 是纯 SQL 兜底，仍按会话行为出候选', async () => {
    const viewer = await createUser()
    const seller = await createUser()
    const listing = await createListing({ sellerId: seller, category: 'BOOKS' })
    await putEmbedding(listing.id, X, { sourceUpdatedAt: listing.updatedAt })
    // 会话行为落在 BOOKS：category 通道即使拿不到模型，也必须能据此出候选。
    await addEvent({
      userId: viewer,
      listingId: listing.id,
      eventType: 'DETAIL_VIEW',
      occurredAt: new Date(),
    })

    const result = await createRecommendationRecall({ db, embeddingModel: null }).recall({
      userId: viewer,
      anonymousSessionId: null,
    })

    const byChannel = new Map(result.channels.map((channel) => [channel.channel, channel]))
    expect(byChannel.get('semantic')?.degradedReason).toBe('model_unavailable')
    // category 不读向量（Issue M2：semantic 不可用时它是兜底通道），因此不随模型一起降级。
    expect(byChannel.get('category')?.degradedReason).toBeNull()
    expect(byChannel.get('category')?.candidateCount).toBeGreaterThan(0)
    expect(byChannel.get('wish')?.degradedReason).toBeNull()
    expect(byChannel.get('fresh')?.degradedReason).toBeNull()

    // 画像向量确实拿不到（两路都无），但候选不能因此变空。
    expect(result.interest).toEqual({ session: false, longTerm: false, combined: false })
    expect(result.candidates.map((row) => row.listingId)).toContain(listing.id)
    expect(findCandidate(result.candidates, listing.id)?.recallSources).toContain('category')
  })

  test('完全无身份：semantic / category / wish 记 no_profile，fresh / popular / explore 兜底', async () => {
    const seller = await createUser()
    const listing = await createListing({ sellerId: seller, category: 'BOOKS' })

    const result = await recall().recall({ userId: null, anonymousSessionId: null })

    const byChannel = new Map(result.channels.map((channel) => [channel.channel, channel]))
    expect(byChannel.get('semantic')?.degradedReason).toBe('no_profile')
    expect(byChannel.get('category')?.degradedReason).toBe('no_profile')
    expect(byChannel.get('wish')?.degradedReason).toBe('no_profile')
    expect(byChannel.get('fresh')?.degradedReason).toBeNull()
    expect(result.interest).toEqual({ session: false, longTerm: false, combined: false })
    expect(result.candidates.map((row) => row.listingId)).toContain(listing.id)
  })

  test('匿名会话能用 session 行为算兴趣（wish 路没有愿望可匹配，记 no_profile）', async () => {
    const seller = await createUser()
    const session = newId()
    const now = new Date()

    const listing = await createListing({ sellerId: seller, category: 'BOOKS' })
    await putEmbedding(listing.id, X, { sourceUpdatedAt: listing.updatedAt })
    await addEvent({
      anonymousSessionId: session,
      listingId: listing.id,
      eventType: 'DETAIL_VIEW',
      occurredAt: new Date(now.getTime() - MINUTE),
    })

    const result = await recall().recall({ userId: null, anonymousSessionId: session })

    const byChannel = new Map(result.channels.map((channel) => [channel.channel, channel]))
    expect(byChannel.get('wish')?.degradedReason).toBe('no_profile')
    expect(byChannel.get('semantic')?.degradedReason).toBeNull()
    expect(result.interest).toEqual({ session: true, longTerm: false, combined: true })
    expect(findCandidate(result.candidates, listing.id)?.recallSources).toContain('semantic')
  })

  test('长期画像版本不符时不当现行画像用（R2 交接：strategy_version 只写不读）', async () => {
    const viewer = await createUser()
    const seller = await createUser()
    const now = new Date()

    // 只有长期画像（Y 方向），session 无行为；版本是旧版 → 必须无视。
    const listing = await createListing({ sellerId: seller, category: 'BOOKS' })
    await putEmbedding(listing.id, Y, { sourceUpdatedAt: listing.updatedAt })
    await putInterestProfile({ userId: viewer, embedding: Y, strategyVersion: 'interest-v0' })

    const stale = await recall().recall({ userId: viewer, anonymousSessionId: null })
    expect(stale.interest).toEqual({ session: false, longTerm: false, combined: false })
    const staleSemantic = stale.channels.find((channel) => channel.channel === 'semantic')
    expect(staleSemantic?.degradedReason).toBe('no_profile')

    // 版本正确则作为长期兴趣参与合成。
    await db.$client.unsafe('truncate table user_interest_profiles')
    await putInterestProfile({ userId: viewer, embedding: Y })
    await addEvent({
      userId: viewer,
      listingId: listing.id,
      eventType: 'DETAIL_VIEW',
      occurredAt: new Date(now.getTime() - MINUTE),
    })

    const fresh = await recall().recall({ userId: viewer, anonymousSessionId: null })
    expect(fresh.interest).toEqual({ session: true, longTerm: true, combined: true })
    expect(fresh.candidates.map((row) => row.listingId)).toContain(listing.id)
  })

  test('长期画像读取失败报 provider_error，不能伪装成"这个人没有画像"（验收项 2）', async () => {
    const viewer = await createUser()
    const seller = await createUser()

    const listing = await createListing({ sellerId: seller, category: 'BOOKS' })
    await putEmbedding(listing.id, X, { sourceUpdatedAt: listing.updatedAt })

    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    // 让读取**真的失败**：把表改名，`select ... from user_interest_profiles` 会报 42P01。
    // 与"表在、但这个人没有画像行"是两回事——后者是正常冷启动，前者是部署故障。
    await db.$client.unsafe(
      'alter table user_interest_profiles rename to user_interest_profiles_probe',
    )
    let degraded: string | null | undefined
    try {
      const result = await recall().recall({ userId: viewer, anonymousSessionId: null })
      degraded = result.channels.find((channel) => channel.channel === 'semantic')?.degradedReason
      expect(result.interest).toEqual({ session: false, longTerm: false, combined: false })
    } finally {
      await db.$client.unsafe(
        'alter table user_interest_profiles_probe rename to user_interest_profiles',
      )
      warn.mockRestore()
    }

    expect(degraded).toBe('provider_error')
  })

  test('整层不抛错：数据库全挂时六路各自降级为空候选 + provider_error', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const brokenDb = {
      select: () => {
        throw new Error('模拟数据库不可用')
      },
    } as unknown as Db

    try {
      const result = await createRecommendationRecall({
        db: brokenDb,
        embeddingModel: MODEL,
      }).recall({ userId: newId(), anonymousSessionId: null })

      expect(result.candidates).toEqual([])
      expect(result.channels.map((channel) => channel.channel)).toEqual([
        'fresh',
        'popular',
        'semantic',
        'wish',
        'category',
        'explore',
      ])
      for (const channel of result.channels) {
        expect(channel.degradedReason).toBe('provider_error')
        expect(channel.candidateCount).toBe(0)
      }
      // 兴趣也失败：不能因为"读不出画像"就把请求打挂，但必须如实记账。
      expect(result.interest).toEqual({ session: false, longTerm: false, combined: false })
      expect(warn.mock.calls.length).toBeGreaterThanOrEqual(6)
    } finally {
      warn.mockRestore()
    }
  })
})
