import { expect, test } from 'bun:test'
import { createDb } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { listingMediaObjects } from '@fish/db/schema/listing-media'
import { listingImages, listings } from '@fish/db/schema/listings'
import { users } from '@fish/db/schema/users'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { eq } from 'drizzle-orm'
import { createListingMediaSettlement } from './listing-media-settlement'
import { isListingReviewMediaKey, listingReviewMediaPrefix } from './review-media'
import type { MediaStorage } from './storage'

// 与 packages/db 的集成测试同一约定：没有 DATABASE_URL 就明确失败，而不是静默跳过。
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const db = createDb(databaseUrl)
const IMAGE_BYTES = new Uint8Array([7, 7, 7, 7])

type WrittenObject = { key: string; bytes: Uint8Array; contentType: string }
type FakeStorage = MediaStorage & { writes: WrittenObject[]; reads: number }

function fakeStorage(objects: Map<string, Uint8Array>): FakeStorage {
  const writes: WrittenObject[] = []
  const fake: FakeStorage = {
    writes,
    reads: 0,
    presignPut: () => ({ url: '', headers: {}, expiresAt: '' }),
    stat: async () => ({ size: IMAGE_BYTES.length, contentType: 'image/jpeg' }),
    publicUrl: (key) => `https://cdn.test/${key}`,
    readMediaBytes: async (key) => {
      fake.reads += 1
      return objects.get(key) ?? null
    },
    writeMediaBytes: async (key, bytes, contentType) => {
      writes.push({ key, bytes, contentType })
      objects.set(key, bytes)
    },
  }
  return fake
}

async function createUser(): Promise<string> {
  const rows = await db
    .insert(users)
    .values({
      studentNo: `listing-media-settle-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      passwordHash: 'test-not-a-real-hash',
      nickname: '集成测试',
    })
    .returning({ id: users.id })
  const row = rows[0]
  if (!row) throw new Error('insert users 未返回行')
  return row.id
}

/** 一张已经 confirm 成 REVIEW 的图：私有键 + 媒体行 + 商品图片组一行。 */
type ReviewFixture = {
  sellerId: string
  listingId: string
  reviewKey: string
  objects: Map<string, Uint8Array>
  storage: FakeStorage
}

/** 每个用例自建、自清自己的数据（`listing_images` 随商品级联，媒体行随用户级联）。 */
async function withReviewListing(run: (fixture: ReviewFixture) => Promise<void>) {
  const sellerId = await createUser()
  const listingId = newId()
  await db.insert(listings).values({
    id: listingId,
    listingNo: await reserveTestListingNo(db, listingId),
    sellerId,
    title: '待人工审核的商品',
    description: '集成测试',
    priceCents: 1000,
    category: 'DIGITAL',
    condition: 'GOOD',
    status: 'OFFLINE',
    moderationStatus: 'REVIEW',
  })

  const reviewKey = `${listingReviewMediaPrefix(sellerId)}${encodePublicId(PUBLIC_ID_PREFIX.media, newId())}.jpg`
  const objects = new Map<string, Uint8Array>([[reviewKey, IMAGE_BYTES]])
  const storage = fakeStorage(objects)
  await db.insert(listingMediaObjects).values({
    userId: sellerId,
    stagingKey: `listing-media/${sellerId}/${newId()}.jpg`,
    finalKey: reviewKey,
    contentDigest: 'a'.repeat(64),
    providerMd5: null,
    moderationDecision: 'REVIEW',
    provider: 'LOCAL',
    providerRequestId: null,
  })
  await db.insert(listingImages).values({ listingId, objectKey: reviewKey, sortOrder: 0 })

  try {
    await run({ sellerId, listingId, reviewKey, objects, storage })
  } finally {
    await db.delete(listings).where(eq(listings.id, listingId))
    await db.delete(users).where(eq(users.id, sellerId))
  }
}

function mediaRowOf(reviewKey: string) {
  return db
    .select()
    .from(listingMediaObjects)
    .where(eq(listingMediaObjects.finalKey, reviewKey))
    .limit(1)
}

test('人工 ALLOW 把私有审核对象搬到公开前缀，并同事务改写媒体行与商品图片键', async () => {
  await withReviewListing(async ({ sellerId, listingId, reviewKey, storage }) => {
    expect(isListingReviewMediaKey(reviewKey)).toBe(true)
    const settlement = createListingMediaSettlement({ storage })

    await db.transaction(async (tx) => {
      await settlement(tx, { listingId, decision: 'ALLOW' })
    })

    // 对象被搬到公开前缀（匿名白名单里的那个前缀），字节原样。
    expect(storage.reads).toBe(1)
    expect(storage.writes).toHaveLength(1)
    const publicKey = storage.writes[0]?.key ?? ''
    expect(
      publicKey.startsWith(`listings/${encodePublicId(PUBLIC_ID_PREFIX.user, sellerId)}/`),
    ).toBe(true)
    expect(storage.writes[0]?.bytes).toBe(IMAGE_BYTES)
    expect(storage.writes[0]?.contentType).toBe('image/jpeg')
    expect(isListingReviewMediaKey(publicKey)).toBe(false)

    // 媒体行：可引用键换成公开键，结算结论落库（旧的私有键不再可查）。
    const rows = await db
      .select()
      .from(listingMediaObjects)
      .where(eq(listingMediaObjects.userId, sellerId))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.finalKey).toBe(publicKey)
    expect(rows[0]?.moderationDecision).toBe('REVIEW')
    expect(rows[0]?.settledDecision).toBe('ALLOW')
    expect(rows[0]?.settledAt).toBeInstanceOf(Date)
    expect(await mediaRowOf(reviewKey)).toHaveLength(0)

    // 商品图片组跟着换键：卖家下一次"不改图"的编辑因此读到的是已结算的公开键。
    const images = await db
      .select()
      .from(listingImages)
      .where(eq(listingImages.listingId, listingId))
    expect(images.map((image) => image.objectKey)).toEqual([publicKey])
  })
})

test('人工 BLOCK 只落结算结论，不搬对象、不改商品图片键', async () => {
  await withReviewListing(async ({ listingId, reviewKey, storage }) => {
    const settlement = createListingMediaSettlement({ storage })

    await db.transaction(async (tx) => {
      await settlement(tx, { listingId, decision: 'BLOCK' })
    })

    expect(storage.reads).toBe(0)
    expect(storage.writes).toEqual([])
    const [row] = await mediaRowOf(reviewKey)
    expect(row?.settledDecision).toBe('BLOCK')
    expect(row?.settledAt).toBeInstanceOf(Date)
    const images = await db
      .select()
      .from(listingImages)
      .where(eq(listingImages.listingId, listingId))
    expect(images.map((image) => image.objectKey)).toEqual([reviewKey])
  })
})

test('重复结算（决策重试）不会把同一个对象搬第二遍', async () => {
  await withReviewListing(async ({ listingId, storage }) => {
    const settlement = createListingMediaSettlement({ storage })

    await db.transaction(async (tx) => {
      await settlement(tx, { listingId, decision: 'ALLOW' })
    })
    const firstKey = storage.writes[0]?.key
    await db.transaction(async (tx) => {
      await settlement(tx, { listingId, decision: 'ALLOW' })
    })

    expect(storage.writes).toHaveLength(1)
    expect(storage.writes[0]?.key).toBe(firstKey)
  })
})

test('私有对象缺失时结算失败（事务回滚），不留下"已放行但图不可读"的半截状态', async () => {
  await withReviewListing(async ({ listingId, reviewKey, objects, storage }) => {
    // 人工放行发生在对象丢失之后（例如被生命周期策略删掉）：必须整个决策失败。
    objects.delete(reviewKey)
    const settlement = createListingMediaSettlement({ storage })

    await expect(
      db.transaction(async (tx) => {
        await settlement(tx, { listingId, decision: 'ALLOW' })
      }),
    ).rejects.toThrow('审核图片对象缺失')

    const [row] = await mediaRowOf(reviewKey)
    expect(row?.settledDecision).toBeNull()
    const images = await db
      .select()
      .from(listingImages)
      .where(eq(listingImages.listingId, listingId))
    expect(images.map((image) => image.objectKey)).toEqual([reviewKey])
  })
})

/** 同一张审核图被两个商品引用：客户端正常流程不产生（每个表单都新传对象），只有直接复用键才会。 */
type SharedFixture = {
  sellerId: string
  blockedListingId: string
  pendingListingId: string
  reviewKey: string
  storage: FakeStorage
}

async function withSharedReviewKey(run: (fixture: SharedFixture) => Promise<void>) {
  const sellerId = await createUser()
  const blockedListingId = newId()
  const pendingListingId = newId()
  for (const [index, id] of [blockedListingId, pendingListingId].entries()) {
    await db.insert(listings).values({
      id,
      listingNo: await reserveTestListingNo(db, id),
      sellerId,
      title: `共享审核图的商品 ${index}`,
      description: '集成测试',
      priceCents: 1000,
      category: 'DIGITAL',
      condition: 'GOOD',
      status: 'OFFLINE',
      moderationStatus: 'REVIEW',
    })
  }

  const reviewKey = `${listingReviewMediaPrefix(sellerId)}${encodePublicId(PUBLIC_ID_PREFIX.media, newId())}.jpg`
  const objects = new Map<string, Uint8Array>([[reviewKey, IMAGE_BYTES]])
  const storage = fakeStorage(objects)
  await db.insert(listingMediaObjects).values({
    userId: sellerId,
    stagingKey: `listing-media/${sellerId}/${newId()}.jpg`,
    finalKey: reviewKey,
    contentDigest: 'c'.repeat(64),
    providerMd5: null,
    moderationDecision: 'REVIEW',
    provider: 'LOCAL',
    providerRequestId: null,
  })
  await db.insert(listingImages).values([
    { listingId: blockedListingId, objectKey: reviewKey, sortOrder: 0 },
    { listingId: pendingListingId, objectKey: reviewKey, sortOrder: 0 },
  ])

  try {
    await run({ sellerId, blockedListingId, pendingListingId, reviewKey, storage })
  } finally {
    await db.delete(listings).where(eq(listings.sellerId, sellerId))
    await db.delete(users).where(eq(users.id, sellerId))
  }
}

test('同一个键已被人工 BLOCK 时，另一个引用它的商品不能被放行（阻断过的字节不得进公开前缀）', async () => {
  await withSharedReviewKey(async ({ blockedListingId, pendingListingId, reviewKey, storage }) => {
    const settlement = createListingMediaSettlement({ storage })

    await db.transaction(async (tx) => {
      await settlement(tx, { listingId: blockedListingId, decision: 'BLOCK' })
    })

    await expect(
      db.transaction(async (tx) => {
        await settlement(tx, { listingId: pendingListingId, decision: 'ALLOW' })
      }),
    ).rejects.toThrow('审核图片已被人工阻断')

    expect(storage.reads).toBe(0)
    expect(storage.writes).toEqual([])
    const [row] = await mediaRowOf(reviewKey)
    expect(row?.settledDecision).toBe('BLOCK')
    const images = await db
      .select()
      .from(listingImages)
      .where(eq(listingImages.listingId, pendingListingId))
    expect(images.map((image) => image.objectKey)).toEqual([reviewKey])
  })
})

test('同一个键被另一条商品放行后，所有引用该键的商品图片一起改成公开键（不留私有键残引用）', async () => {
  await withSharedReviewKey(async ({ blockedListingId, pendingListingId, reviewKey, storage }) => {
    const settlement = createListingMediaSettlement({ storage })

    await db.transaction(async (tx) => {
      await settlement(tx, { listingId: blockedListingId, decision: 'ALLOW' })
    })
    expect(storage.writes).toHaveLength(1)
    const publicKey = storage.writes[0]?.key ?? ''
    expect(isListingReviewMediaKey(publicKey)).toBe(false)
    expect(reviewKey).not.toBe(publicKey)

    // 引用同一个键的另一条商品也必须一起改成公开键：否则它会停在"已人工放行但图仍是私有键"，
    // 而且媒体行的 `final_key` 已经改名，它自己再放行时既搬不动、也没有台账行可查。
    const images = await db
      .select()
      .from(listingImages)
      .where(eq(listingImages.listingId, pendingListingId))
    expect(images.map((image) => image.objectKey)).toEqual([publicKey])

    // 它自己的人工放行因此是空操作：图片组里已经没有审核中的私有键，不会重复搬运。
    await db.transaction(async (tx) => {
      await settlement(tx, { listingId: pendingListingId, decision: 'ALLOW' })
    })
    expect(storage.writes).toHaveLength(1)
    const after = await db
      .select()
      .from(listingImages)
      .where(eq(listingImages.listingId, pendingListingId))
    expect(after.map((image) => image.objectKey)).toEqual([publicKey])
  })
})

test('台账行缺失（脏数据）时拒绝人工放行，不放过一张结论不明的图', async () => {
  await withReviewListing(async ({ sellerId, listingId, reviewKey, storage }) => {
    // 引用着私有键、却没有对应台账行：没有任何正常来源（放行会在同一事务里把两边一起改写），
    // 因此宁可让这次人工决策失败（商品留在队列），也不能放行。
    await db.delete(listingMediaObjects).where(eq(listingMediaObjects.userId, sellerId))
    const settlement = createListingMediaSettlement({ storage })

    await expect(
      db.transaction(async (tx) => {
        await settlement(tx, { listingId, decision: 'ALLOW' })
      }),
    ).rejects.toThrow('台账缺失')

    expect(storage.reads).toBe(0)
    expect(storage.writes).toEqual([])
    const images = await db
      .select()
      .from(listingImages)
      .where(eq(listingImages.listingId, listingId))
    expect(images.map((image) => image.objectKey)).toEqual([reviewKey])
  })
})
