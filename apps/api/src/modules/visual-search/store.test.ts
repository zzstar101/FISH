import { afterAll, describe, expect, test } from 'bun:test'
import { createDb } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { favorites } from '@fish/db/schema/favorites'
import { listingNumbers } from '@fish/db/schema/listing-numbers'
import { listingImages, listings } from '@fish/db/schema/listings'
import { users } from '@fish/db/schema/users'
import { VISUAL_EMBEDDING_DIMENSIONS } from '@fish/db/schema/visual-embeddings'
import { visualQueryImages } from '@fish/db/schema/visual-query-images'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { saveVisualEmbedding } from '@fish/db/visual-embedding-store'
import { and, eq, inArray } from 'drizzle-orm'
import { toListingCard } from '../listings/card'
import { createVisualSearchStore } from './store'

// 与 #322 / #324 worker 侧集成测试同一约定：没有 DATABASE_URL 就明确失败，而不是静默跳过。
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const db = createDb(databaseUrl)
const store = createVisualSearchStore(db)

const createdUserIds: string[] = []
const createdListingIds: string[] = []
const createdQueryObjectKeys: string[] = []

afterAll(async () => {
  if (createdQueryObjectKeys.length > 0) {
    await db
      .delete(visualQueryImages)
      .where(inArray(visualQueryImages.objectKey, createdQueryObjectKeys))
  }
  if (createdListingIds.length > 0) {
    // `favorites.listing_id` 的外键是 NO ACTION：商品行删不掉，必须由测试先清掉关系。
    await db.delete(favorites).where(inArray(favorites.listingId, createdListingIds))
    // 删 listings 时 `listing_images` / `listing_visual_embeddings` 由 ON DELETE CASCADE 带走。
    await db.delete(listings).where(inArray(listings.id, createdListingIds))
    // `listing_numbers` 是 append-only 的独立预约表（没有指向 listings 的 FK），要显式清掉。
    await db.delete(listingNumbers).where(inArray(listingNumbers.listingId, createdListingIds))
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds))
  }
  await db.$client.close()
})

let seq = 0

async function createUser(): Promise<string> {
  const rows = await db
    .insert(users)
    .values({
      studentNo: `visual-store-${Date.now()}-${seq++}`,
      passwordHash: 'test-not-a-real-hash',
      nickname: '视觉搜索 store 测试',
    })
    .returning({ id: users.id })
  const row = rows[0]
  if (!row) throw new Error('insert users 未返回行')
  createdUserIds.push(row.id)
  return row.id
}

/**
 * 每个用例一个独立 model 名：召回按 model 过滤，随机后缀让并行测试/上次残留的行都不可能混进来。
 */
function uniqueModel(prefix: string): string {
  return `${prefix}-${newId()}`
}

async function createListing(
  overrides: Partial<typeof listings.$inferInsert> = {},
): Promise<string> {
  const id = newId()
  createdListingIds.push(id)
  await db.insert(listings).values({
    id,
    listingNo: await reserveTestListingNo(db, id),
    sellerId: overrides.sellerId ?? (await createUser()),
    title: '视觉搜索 store 集成测试',
    description: '封面图用于视觉召回',
    priceCents: 12345,
    category: 'DIGITAL',
    condition: 'GOOD',
    ...overrides,
  })
  return id
}

async function addImage(listingId: string, objectKey: string, sortOrder: number): Promise<void> {
  await db.insert(listingImages).values({ listingId, objectKey, sortOrder })
}

/** 封面 = `sort_order = 0` 的那一张；键里带 listingId 保证与商品一一对应且唯一。 */
async function addCover(listingId: string): Promise<string> {
  const objectKey = `listings/${listingId}.png`
  await addImage(listingId, objectKey, 0)
  return objectKey
}

/** 只动前几维，其余补 0。pgvector 是 float4：1 / 0.6 / 0.8 都能精确往返。 */
function vectorOf(entries: number[]): number[] {
  const vector = new Array<number>(VISUAL_EMBEDDING_DIMENSIONS).fill(0)
  for (let i = 0; i < entries.length; i++) vector[i] = entries[i] ?? 0
  return vector
}

async function saveEmbedding(input: {
  listingId: string
  model: string
  sourceObjectKey: string
  embedding: number[]
  sourceUpdatedAt?: Date
}): Promise<void> {
  const written = await saveVisualEmbedding(db, {
    listingId: input.listingId,
    model: input.model,
    dimensions: VISUAL_EMBEDDING_DIMENSIONS,
    sourceObjectKey: input.sourceObjectKey,
    embedding: input.embedding,
    sourceUpdatedAt: input.sourceUpdatedAt ?? new Date(),
  })
  if (!written) throw new Error('saveVisualEmbedding 未写入（CAS 被抢先）')
}

describe('createVisualSearchStore', () => {
  test('recall 只返回 status=ACTIVE 且 moderationStatus=APPROVED 的商品', async () => {
    const model = uniqueModel('visibility')
    const query = vectorOf([1])

    const visible = await createListing({ status: 'ACTIVE', moderationStatus: 'APPROVED' })
    const sold = await createListing({ status: 'SOLD', moderationStatus: 'APPROVED' })
    const review = await createListing({ status: 'ACTIVE', moderationStatus: 'REVIEW' })

    for (const listingId of [visible, sold, review]) {
      const cover = await addCover(listingId)
      // 三个向量完全相同：差异只可能来自可见性过滤。
      await saveEmbedding({ listingId, model, sourceObjectKey: cover, embedding: query })
    }

    const result = await store.recall({ model, vector: query, limit: 10 })

    expect(result.map((row) => row.listingId)).toEqual([visible])
  })

  test('recall 排除 excludeSellerId 本人的商品：同距离只挡自己的，匿名（null）不过滤', async () => {
    const model = uniqueModel('exclude-seller')
    const query = vectorOf([1])

    const viewer = await createUser()
    const otherSeller = await createUser()

    const mine = await createListing({ sellerId: viewer })
    const theirs = await createListing({ sellerId: otherSeller })

    for (const listingId of [mine, theirs]) {
      const cover = await addCover(listingId)
      // 两条向量完全相同：差异只可能来自"排除本人商品"。
      await saveEmbedding({ listingId, model, sourceObjectKey: cover, embedding: query })
    }

    // 登录 Caller：本人商品不返回，别人的同等匹配商品仍返回。
    const authenticated = await store.recall({
      model,
      vector: query,
      limit: 10,
      excludeSellerId: viewer,
    })
    expect(authenticated.map((row) => row.listingId)).toEqual([theirs])

    // 匿名 Caller：没有可排除的主体，两条都返回。
    const anonymous = await store.recall({
      model,
      vector: query,
      limit: 10,
      excludeSellerId: null,
    })
    expect(anonymous.map((row) => row.listingId).sort()).toEqual([mine, theirs].sort())
  })

  test('recall 在 SQL 里先排除本人商品再取 Top-K：被排除的商品不占名额', async () => {
    const model = uniqueModel('exclude-before-limit')
    const query = vectorOf([1])

    const viewer = await createUser()
    const mine = await createListing({ sellerId: viewer })
    const theirsNear = await createListing()
    const theirsFar = await createListing()

    const mineCover = await addCover(mine)
    const nearCover = await addCover(theirsNear)
    const farCover = await addCover(theirsFar)

    // 本人商品距离最近：若"先取 Top-K 再丢自己"，limit=2 只会剩一条。
    await saveEmbedding({
      listingId: mine,
      model,
      sourceObjectKey: mineCover,
      embedding: vectorOf([1]),
    })
    await saveEmbedding({
      listingId: theirsNear,
      model,
      sourceObjectKey: nearCover,
      embedding: vectorOf([0.6, 0.8]),
    })
    await saveEmbedding({
      listingId: theirsFar,
      model,
      sourceObjectKey: farCover,
      embedding: vectorOf([0, 1]),
    })

    const result = await store.recall({
      model,
      vector: query,
      limit: 2,
      excludeSellerId: viewer,
    })

    expect(result.map((row) => row.listingId)).toEqual([theirsNear, theirsFar])
  })

  test('recall 按余弦距离升序返回，且遵守 limit', async () => {
    const model = uniqueModel('order')
    const query = vectorOf([1])

    const nearest = await createListing()
    const middle = await createListing()
    const farthest = await createListing()

    const nearestCover = await addCover(nearest)
    const middleCover = await addCover(middle)
    const farthestCover = await addCover(farthest)

    // 故意按"距离从远到近"插入：丢掉 ORDER BY 时扫描顺序不会恰好等于升序。
    await saveEmbedding({
      listingId: farthest,
      model,
      sourceObjectKey: farthestCover,
      embedding: vectorOf([0, 1]),
    })
    await saveEmbedding({
      listingId: middle,
      model,
      sourceObjectKey: middleCover,
      embedding: vectorOf([0.6, 0.8]),
    })
    await saveEmbedding({
      listingId: nearest,
      model,
      sourceObjectKey: nearestCover,
      embedding: vectorOf([1]),
    })

    const all = await store.recall({ model, vector: query, limit: 3 })
    expect(all.map((row) => row.listingId)).toEqual([nearest, middle, farthest])

    const result = await store.recall({ model, vector: query, limit: 2 })

    expect(result.map((row) => row.listingId)).toEqual([nearest, middle])
    expect(result).toHaveLength(2)
    const first = result[0]
    const second = result[1]
    if (!first || !second) throw new Error('recall 未返回两条候选')
    expect(Number(first.distance)).toBeCloseTo(0, 6)
    expect(Number(second.distance)).toBeCloseTo(0.4, 5)
    expect(Number(first.distance)).toBeLessThan(Number(second.distance))
  })

  test('recall 只召回 source_object_key 等于当前封面的向量行', async () => {
    const model = uniqueModel('freshness')
    const query = vectorOf([1])

    const fresh = await createListing()
    const stale = await createListing()
    const coverRemoved = await createListing()

    const freshCover = await addCover(fresh)
    await addCover(stale)
    const removedCover = await addCover(coverRemoved)

    await saveEmbedding({ listingId: fresh, model, sourceObjectKey: freshCover, embedding: query })
    // 向量指向的不是当前封面（等价于封面换了但向量没重算）：旧键不再对得上。
    await saveEmbedding({
      listingId: stale,
      model,
      sourceObjectKey: 'listings/old-cover.png',
      embedding: query,
    })
    await saveEmbedding({
      listingId: coverRemoved,
      model,
      sourceObjectKey: removedCover,
      embedding: query,
    })
    // 封面被删除（没有 sort_order = 0 的行）：inner join 自然排除。
    await db
      .delete(listingImages)
      .where(and(eq(listingImages.listingId, coverRemoved), eq(listingImages.sortOrder, 0)))

    const result = await store.recall({ model, vector: query, limit: 10 })

    expect(result.map((row) => row.listingId)).toEqual([fresh])
  })

  test('recall 只召回 model 匹配的向量行', async () => {
    const modelA = uniqueModel('model-a')
    const modelB = uniqueModel('model-b')
    const query = vectorOf([1])

    const listingId = await createListing()
    const cover = await addCover(listingId)
    await saveEmbedding({ listingId, model: modelA, sourceObjectKey: cover, embedding: query })
    await saveEmbedding({ listingId, model: modelB, sourceObjectKey: cover, embedding: query })

    const resultA = await store.recall({ model: modelA, vector: query, limit: 10 })
    // 同一商品两条向量行：若 model 过滤失效会变成两行候选。
    expect(resultA.map((row) => row.listingId)).toEqual([listingId])

    const resultB = await store.recall({ model: modelB, vector: query, limit: 10 })
    expect(resultB.map((row) => row.listingId)).toEqual([listingId])

    expect(
      await store.recall({ model: uniqueModel('model-absent'), vector: query, limit: 10 }),
    ).toEqual([])
  })

  test('hasVisualEmbeddings 只对存在该 model 向量的库返回 true', async () => {
    const model = uniqueModel('has')
    const otherModel = uniqueModel('has-other')

    expect(await store.hasVisualEmbeddings(model)).toBe(false)

    const listingId = await createListing()
    const cover = await addCover(listingId)
    await saveEmbedding({ listingId, model, sourceObjectKey: cover, embedding: vectorOf([1]) })

    expect(await store.hasVisualEmbeddings(model)).toBe(true)
    // 只有别的 model 的行 ⇒ 对本 model 仍然是 false。
    expect(await store.hasVisualEmbeddings(otherModel)).toBe(false)
  })

  test('loadListingSignals 返回封面键与收藏数，无封面时为空值', async () => {
    const withCover = await createListing()
    const coverKey = await addCover(withCover)
    const withoutCover = await createListing()
    // 造一张非封面图：没有 sort_order = 0 的行 ⇒ 仍然算"没有封面"。
    await addImage(withoutCover, `listings/${withoutCover}-second.png`, 1)

    const fanA = await createUser()
    const fanB = await createUser()
    await db.insert(favorites).values([
      { userId: fanA, listingId: withCover },
      { userId: fanB, listingId: withCover },
    ])

    const signals = await store.loadListingSignals([withCover, withoutCover])

    expect(signals.get(withCover)).toEqual({
      listingId: withCover,
      coverObjectKey: coverKey,
      favoriteCount: 2,
    })
    expect(signals.get(withoutCover)).toEqual({
      listingId: withoutCover,
      coverObjectKey: null,
      favoriteCount: 0,
    })
  })

  test('loadListings 只返回公开可见商品，且字段齐全可喂给 ListingCardSource', async () => {
    const visible = await createListing({
      title: '在售可见商品',
      priceCents: 2599,
      urgent: true,
      negotiable: true,
    })
    const sold = await createListing({ status: 'SOLD' })
    const review = await createListing({ moderationStatus: 'REVIEW' })

    const result = await store.loadListings([visible, sold, review])

    expect([...result.keys()]).toEqual([visible])
    const row = result.get(visible)
    if (!row) throw new Error('loadListings 未返回可见商品')
    expect(row).toEqual({
      id: visible,
      listingNo: expect.any(BigInt),
      title: '在售可见商品',
      priceCents: 2599,
      category: 'DIGITAL',
      condition: 'GOOD',
      status: 'ACTIVE',
      urgent: true,
      negotiable: true,
      free: false,
      createdAt: expect.any(Date),
    })

    // 真的喂给下游映射函数：字段缺失/类型不对会让 ListingCardSchema 解析失败返回 null。
    const card = toListingCard(row, 'listings/cover.png', {
      publicUrl: (key) => `https://example.test/${key}`,
    })
    expect(card).not.toBeNull()
    expect(card?.title).toBe('在售可见商品')
  })

  test('registerQueryImage + findUsableQueryImage + markQueryImageUsed 的生命周期', async () => {
    const subjectKey = `subject-${newId()}`
    const objectKey = `visual-search/user/${newId()}.jpg`
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000)
    createdQueryObjectKeys.push(objectKey)

    await store.registerQueryImage({
      objectKey,
      subjectType: 'user',
      subjectKey,
      contentType: 'image/jpeg',
      sizeBytes: 2048,
      expiresAt,
    })

    const now = new Date()
    const found = await store.findUsableQueryImage({
      objectKey,
      subjectType: 'user',
      subjectKey,
      now,
    })
    expect(found?.objectKey).toBe(objectKey)
    expect(found?.subjectKey).toBe(subjectKey)
    expect(found?.expiresAt.getTime()).toBe(expiresAt.getTime())

    // 首次标记 true、重复标记 false（used_at IS NULL 守卫）。
    expect(await store.markQueryImageUsed(objectKey)).toBe(true)
    expect(await store.markQueryImageUsed(objectKey)).toBe(false)

    // subjectKey 不匹配 ⇒ 拿不到别人的键。
    expect(
      await store.findUsableQueryImage({
        objectKey,
        subjectType: 'user',
        subjectKey: `other-${newId()}`,
        now,
      }),
    ).toBeNull()

    // 过期行查不到：直接用过去的 expiresAt，不 sleep。
    const expiredKey = `visual-search/user/${newId()}.jpg`
    createdQueryObjectKeys.push(expiredKey)
    await store.registerQueryImage({
      objectKey: expiredKey,
      subjectType: 'user',
      subjectKey,
      contentType: 'image/png',
      sizeBytes: 1024,
      expiresAt: new Date(Date.now() - 60_000),
    })
    expect(
      await store.findUsableQueryImage({
        objectKey: expiredKey,
        subjectType: 'user',
        subjectKey,
        now: new Date(),
      }),
    ).toBeNull()
  })
})
