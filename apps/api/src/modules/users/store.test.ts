import { expect, test } from 'bun:test'
import type { ListingStatus } from '@fish/contracts/listings/schema'
import { createDb } from '@fish/db/client'
import { listingImages, listings } from '@fish/db/schema/listings'
import { transactions } from '@fish/db/schema/transactions'
import { users } from '@fish/db/schema/users'
import { eq, inArray } from 'drizzle-orm'
import { createSqlPublicUserStore } from './store'

// 与 packages/db 的集成测试同一约定：没有 DATABASE_URL 就明确失败，而不是静默跳过。
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const db = createDb(databaseUrl)
const store = createSqlPublicUserStore(db)

let seq = 0
const uniqueStudentNo = () => `public-user-${Date.now()}-${seq++}`

type ListingSpec = {
  status?: ListingStatus
  moderationStatus?: 'APPROVED' | 'BLOCKED' | 'REVIEW'
  createdAt?: Date
  /** 传入即插 `sort_order = 0` 的封面；`extraImageOrder` 用于验证"只有 0 才是封面"。 */
  coverObjectKey?: string
  extraImageObjectKey?: string
}

/**
 * 每个用例自建、自清自己的数据（同 comments / listings 的 store.test.ts 约定）。
 * 只建一个卖家 + 一个买家：本域是"看另一个人的主页"，不需要更多角色。
 * 清库顺序 transactions → listings → users：`listings.seller_id` 的外键是 NO ACTION
 * （`listing_images` 随商品 CASCADE）。
 */
async function withSeller(
  specs: ListingSpec[],
  run: (fixture: { sellerId: string; buyerId: string; listingIds: string[] }) => Promise<void>,
) {
  const sellerRows = await db
    .insert(users)
    .values({
      studentNo: uniqueStudentNo(),
      passwordHash: 'test-not-a-real-hash',
      nickname: '卖家',
    })
    .returning({ id: users.id })
  const sellerId = sellerRows[0]?.id
  if (!sellerId) throw new Error('insert users 未返回行')

  const buyerRows = await db
    .insert(users)
    .values({
      studentNo: uniqueStudentNo(),
      passwordHash: 'test-not-a-real-hash',
      nickname: '买家',
    })
    .returning({ id: users.id })
  const buyerId = buyerRows[0]?.id
  if (!buyerId) throw new Error('insert users 未返回行')

  const listingIds: string[] = []
  try {
    for (const [index, spec] of specs.entries()) {
      const rows = await db
        .insert(listings)
        .values({
          sellerId,
          title: `集成测试商品 ${index}`,
          description: '集成测试描述',
          priceCents: 1000 + index,
          category: 'DIGITAL',
          condition: 'GOOD',
          ...(spec.status ? { status: spec.status } : {}),
          ...(spec.moderationStatus ? { moderationStatus: spec.moderationStatus } : {}),
          ...(spec.createdAt ? { createdAt: spec.createdAt } : {}),
        })
        .returning({ id: listings.id })
      const listingId = rows[0]?.id
      if (!listingId) throw new Error('insert listings 未返回行')
      listingIds.push(listingId)

      const images: { listingId: string; objectKey: string; sortOrder: number }[] = []
      if (spec.coverObjectKey) {
        images.push({ listingId, objectKey: spec.coverObjectKey, sortOrder: 0 })
      }
      if (spec.extraImageObjectKey) {
        images.push({ listingId, objectKey: spec.extraImageObjectKey, sortOrder: 1 })
      }
      if (images.length > 0) await db.insert(listingImages).values(images)
    }

    await run({ sellerId, buyerId, listingIds })
  } finally {
    await db.delete(transactions).where(inArray(transactions.sellerId, [sellerId]))
    await db.delete(listings).where(eq(listings.sellerId, sellerId))
    await db.delete(users).where(inArray(users.id, [sellerId, buyerId]))
  }
}

test('findPublicUser 只 SELECT 公开列，不返回任何私有列', async () => {
  await withSeller([{}], async ({ sellerId }) => {
    const row = await store.findPublicUser(sellerId)

    // 键集合就是"没查私有列"的可验证形式：student_no / campus / campus_email /
    // password_hash / role 一旦被人写进 SELECT，这条会立刻失败。
    expect(Object.keys(row ?? {}).sort()).toEqual([
      'authStatus',
      'avatarUrl',
      'createdAt',
      'id',
      'nickname',
    ])
  })
})

test('findPublicUser 对不存在的用户返回 null', async () => {
  expect(await store.findPublicUser('01930000-0000-7000-8000-0000000000ff')).toBeNull()
})

test('stats：在售只算 ACTIVE + APPROVED，卖出只算 COMPLETED', async () => {
  const base = new Date('2026-09-01T00:00:00.000Z')
  await withSeller(
    [
      { status: 'SOLD' },
      { status: 'RESERVED' },
      { status: 'ACTIVE' },
      // 审核未通过的 ACTIVE 商品不能算进"在售"（公开可见性的第二道闸）。
      { status: 'ACTIVE', moderationStatus: 'REVIEW' },
      { status: 'ACTIVE' },
    ],
    async ({ sellerId, buyerId, listingIds }) => {
      const sold = listingIds[0] as string
      const reserved = listingIds[1] as string
      const cancelled = listingIds[2] as string

      await db.insert(transactions).values([
        {
          listingId: sold,
          buyerId,
          sellerId,
          amountCents: 1200,
          status: 'COMPLETED',
          completedAt: base,
          buyerConfirmedAt: base,
          sellerConfirmedAt: base,
        },
        // 进行中不算成交。
        { listingId: reserved, buyerId, sellerId, amountCents: 1300 },
        // 已取消不算成交（`completed_at` 与 `cancelled_at` 由 check 约束绑定状态）。
        {
          listingId: cancelled,
          buyerId,
          sellerId,
          amountCents: 1400,
          status: 'CANCELLED',
          cancelledAt: base,
        },
      ])

      expect(await store.stats(sellerId)).toEqual({ activeListings: 2, soldCount: 1 })
    },
  )
})

test('listActiveListings 只出 ACTIVE + APPROVED，时间倒序，且与 stats 的在售数一致', async () => {
  await withSeller(
    [
      { status: 'SOLD', createdAt: new Date('2026-09-09T00:00:00.000Z') },
      { status: 'OFFLINE', createdAt: new Date('2026-09-08T00:00:00.000Z') },
      {
        status: 'ACTIVE',
        moderationStatus: 'BLOCKED',
        createdAt: new Date('2026-09-07T00:00:00.000Z'),
      },
      { status: 'ACTIVE', createdAt: new Date('2026-09-06T00:00:00.000Z') },
      { status: 'ACTIVE', createdAt: new Date('2026-09-05T00:00:00.000Z') },
    ],
    async ({ sellerId, listingIds }) => {
      const rows = await store.listActiveListings(sellerId, 20, null)

      expect(rows.map((row) => row.id)).toEqual([listingIds[3] as string, listingIds[4] as string])
      expect(rows.every((row) => row.status === 'ACTIVE')).toBe(true)
      expect((await store.stats(sellerId)).activeListings).toBe(rows.length)
    },
  )
})

test('游标翻页不重不漏：nextCursor 落在最后一条已返回的行上', async () => {
  await withSeller(
    [
      { createdAt: new Date('2026-09-03T00:00:00.000Z') },
      { createdAt: new Date('2026-09-02T00:00:00.000Z') },
      { createdAt: new Date('2026-09-01T00:00:00.000Z') },
    ],
    async ({ sellerId, listingIds }) => {
      // store 约定多取一行：limit=2 时返回 3 行，由 service 判断还有没有下一页。
      const firstFetch = await store.listActiveListings(sellerId, 2, null)
      expect(firstFetch).toHaveLength(3)

      const lastReturned = firstFetch[1]
      if (!lastReturned) throw new Error('第一页应当有第二行')

      const secondPage = await store.listActiveListings(sellerId, 2, {
        createdAt: lastReturned.createdAtCursor,
        id: lastReturned.id,
      })

      expect(secondPage.map((row) => row.id)).toEqual([listingIds[2] as string])
    },
  )
})

test('封面只认 sort_order = 0，取不到就是 null（不用序号更大的图片顶替）', async () => {
  await withSeller(
    [
      { coverObjectKey: 'listings/cover.jpg', extraImageObjectKey: 'listings/second.jpg' },
      { extraImageObjectKey: 'listings/only-second.jpg' },
    ],
    async ({ sellerId, listingIds }) => {
      const rows = await store.listActiveListings(sellerId, 20, null)
      const byId = new Map(rows.map((row) => [row.id, row]))

      expect(byId.get(listingIds[0] as string)?.coverObjectKey).toBe('listings/cover.jpg')
      expect(byId.get(listingIds[1] as string)?.coverObjectKey).toBeNull()
    },
  )
})
