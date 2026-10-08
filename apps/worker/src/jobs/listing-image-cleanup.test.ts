import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { createDb } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { listingImageDeletions } from '@fish/db/schema/listing-image-deletions'
import { listingImages, listings } from '@fish/db/schema/listings'
import { users } from '@fish/db/schema/users'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { eq, inArray, like } from 'drizzle-orm'
import type { WorkerMediaStorage } from '../media-storage'
import { cleanupRemovedListingImages } from './listing-image-cleanup'

// 与 #322 文本侧同一约定：没有 DATABASE_URL 就明确失败，而不是静默跳过。
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const db = createDb(databaseUrl)

/**
 * 用"过去的 now"把本文件的行与真实时间线隔开：回收取的是**全表**里 `removed_at <= cutoff` 的行，
 * 而本文件造的键用独一无二的前缀、其它行的 `removed_at` 都在当下之后，所以只有本文件的行会到期，
 * `scanned` / `deleted` 才能断言成精确值。
 */
const NOW = new Date('2020-01-01T00:00:00.000Z')

/** 一小时 = 默认保留期（24h）的一部分，用来构造"已到期 / 未到期"。 */
const HOUR_MS = 60 * 60 * 1000

function removedAt(hoursAgo: number): Date {
  return new Date(NOW.getTime() - hoursAgo * HOUR_MS)
}

const KEY_PREFIX = 'listings/cleanup-test-'
let seq = 0

function makeKey(label: string): string {
  return `${KEY_PREFIX}${label}-${seq++}/img.jpg`
}

const createdUserIds: string[] = []

async function createUser(): Promise<string> {
  const rows = await db
    .insert(users)
    .values({
      studentNo: `image-cleanup-${Date.now()}-${seq++}`,
      passwordHash: 'test-not-a-real-hash',
      nickname: '集成测试',
    })
    .returning({ id: users.id })
  const row = rows[0]
  if (!row) throw new Error('insert users 未返回行')
  createdUserIds.push(row.id)
  return row.id
}

async function createListing(sellerId: string): Promise<string> {
  const id = newId()
  await db.insert(listings).values({
    id,
    listingNo: await reserveTestListingNo(db, id),
    sellerId,
    title: '图片清理集成测试商品',
    description: '集成测试',
    priceCents: 100,
    category: 'OTHER',
    condition: 'GOOD',
  })
  return id
}

/** 直接把键挂到某条商品上（回收的引用判据只看 `listing_images.object_key`）。 */
async function referenceKey(listingId: string, objectKey: string, sortOrder = 0): Promise<void> {
  await db.insert(listingImages).values({ listingId, objectKey, sortOrder })
}

/** 直接登记一条待删行，`removed_at` 由用例控制（写路径的登记用的是 DB now()，测试要造过期行）。 */
async function registerDeletion(objectKey: string, at: Date): Promise<void> {
  await db.insert(listingImageDeletions).values({ objectKey, removedAt: at })
}

function deletionRowCount(objectKey: string): Promise<number> {
  return db.$count(listingImageDeletions, eq(listingImageDeletions.objectKey, objectKey))
}

/**
 * 记录 `deleteObject` 的调用，并在**调用那一刻**回查台账，作为"对象先于行删除"的证据：
 * 实现若先把行删了，这里会记录到 `rowPresent=false`。
 */
function recordingStorage(log: string[]): WorkerMediaStorage {
  return {
    async readBytes() {
      return null
    },
    async deleteObject(key) {
      const present = await db.$count(
        listingImageDeletions,
        eq(listingImageDeletions.objectKey, key),
      )
      log.push(`deleteObject:${key}:rowPresent=${present > 0}`)
    },
  }
}

afterEach(async () => {
  // 只清本文件命名空间的对象与用户；键前缀独一无二，不会碰别人的数据。
  await db
    .delete(listingImageDeletions)
    .where(like(listingImageDeletions.objectKey, `${KEY_PREFIX}%`))
  if (createdUserIds.length > 0) {
    const owned = await db
      .select({ id: listings.id })
      .from(listings)
      .where(inArray(listings.sellerId, createdUserIds))
    if (owned.length > 0) {
      // listing_images 随 listings 级联（见 deleteListingAtomic 的口径）。
      await db.delete(listings).where(
        inArray(
          listings.id,
          owned.map((row) => row.id),
        ),
      )
    }
    await db.delete(users).where(inArray(users.id, createdUserIds))
    createdUserIds.length = 0
  }
})

afterAll(async () => {
  await db
    .delete(listingImageDeletions)
    .where(like(listingImageDeletions.objectKey, `${KEY_PREFIX}%`))
  await db.$client.close()
})

describe('cleanupRemovedListingImages', () => {
  test('到期行：先删对象再删台账行', async () => {
    const key = makeKey('due')
    await registerDeletion(key, removedAt(30))

    const log: string[] = []
    const result = await cleanupRemovedListingImages({
      db,
      storage: recordingStorage(log),
      now: NOW,
    })

    expect(result).toEqual({ scanned: 1, deleted: 1, skipped: 0 })
    // rowPresent=true 只在"先删对象"的实现下成立：顺序一旦反了，这里会是 false。
    expect(log).toEqual([`deleteObject:${key}:rowPresent=true`])
    expect(await deletionRowCount(key)).toBe(0)
  })

  test('未到期的待删行原样保留', async () => {
    const key = makeKey('not-due')
    // 保留期默认 24h，2 小时前摘除的键还没到期。
    await registerDeletion(key, removedAt(2))

    const log: string[] = []
    const result = await cleanupRemovedListingImages({
      db,
      storage: recordingStorage(log),
      now: NOW,
    })

    expect(result).toEqual({ scanned: 0, deleted: 0, skipped: 0 })
    expect(log).toEqual([])
    expect(await deletionRowCount(key)).toBe(1)
  })

  test('同一键仍被多条商品引用时不误删，台账行保留', async () => {
    const sellerId = await createUser()
    const first = await createListing(sellerId)
    const second = await createListing(sellerId)
    const key = makeKey('shared')
    // 两条商品都还引用着这把键 —— 一条商品摘除了它并不能说明它没人在用。
    await referenceKey(first, key)
    await referenceKey(second, key)
    await registerDeletion(key, removedAt(30))

    const log: string[] = []
    const result = await cleanupRemovedListingImages({
      db,
      storage: recordingStorage(log),
      now: NOW,
    })

    expect(result).toEqual({ scanned: 1, deleted: 0, skipped: 1 })
    expect(log).toEqual([])
    // 台账行保留：该键今后真的被摘除时，写路径会刷新 removed_at 重新起算保留期。
    expect(await deletionRowCount(key)).toBe(1)
  })

  test('删对象失败：行不删、错误冒出，下一轮重试同一行', async () => {
    const key = makeKey('throwing')
    await registerDeletion(key, removedAt(30))

    const failing: WorkerMediaStorage = {
      async readBytes() {
        return null
      },
      async deleteObject() {
        throw new Error('对象删除失败')
      },
    }

    await expect(cleanupRemovedListingImages({ db, storage: failing, now: NOW })).rejects.toThrow(
      '对象删除失败',
    )

    // 对象删失败时绝不能删行：行一删，这个键就永远没人记得删了。
    expect(await deletionRowCount(key)).toBe(1)

    // 下一轮重新捡起同一行（对象恢复可删）。
    const log: string[] = []
    const result = await cleanupRemovedListingImages({
      db,
      storage: recordingStorage(log),
      now: NOW,
    })
    expect(result).toEqual({ scanned: 1, deleted: 1, skipped: 0 })
    expect(log).toEqual([`deleteObject:${key}:rowPresent=true`])
    expect(await deletionRowCount(key)).toBe(0)
  })

  test('limit 生效：3 条到期行 + limit 2 → 只删最早摘除的 2 条', async () => {
    const oldest = makeKey('limit-oldest')
    const middle = makeKey('limit-middle')
    const newest = makeKey('limit-newest')
    // 三小时刻都必须**超过 24h 保留期**才算到期；用 30/40/50 小时前摘除区分先后。
    await registerDeletion(newest, removedAt(30))
    await registerDeletion(oldest, removedAt(50))
    await registerDeletion(middle, removedAt(40))

    const log: string[] = []
    const result = await cleanupRemovedListingImages({
      db,
      storage: recordingStorage(log),
      now: NOW,
      limit: 2,
    })

    expect(result).toEqual({ scanned: 2, deleted: 2, skipped: 0 })
    // 先摘除的先删：对象删除顺序必须与 removed_at 升序一致。
    expect(log).toEqual([
      `deleteObject:${oldest}:rowPresent=true`,
      `deleteObject:${middle}:rowPresent=true`,
    ])
    expect(await deletionRowCount(oldest)).toBe(0)
    expect(await deletionRowCount(middle)).toBe(0)
    expect(await deletionRowCount(newest)).toBe(1)
  })
})
