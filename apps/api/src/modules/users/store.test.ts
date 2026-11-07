import { expect, test } from 'bun:test'
import { DELETED_ACCOUNT_NICKNAME } from '@fish/contracts/account-deletion/schema'
import type { ListingStatus } from '@fish/contracts/listings/schema'
import { createDb } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { listingImages, listings } from '@fish/db/schema/listings'
import { recommendationEvents } from '@fish/db/schema/recommendation-events'
import { transactions } from '@fish/db/schema/transactions'
import { users } from '@fish/db/schema/users'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { eq, inArray, sql } from 'drizzle-orm'
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
  /** 平台治理下架时刻（#565）：与 `status` 正交，核销路径会把这类商品置成 SOLD。 */
  governanceDelistedAt?: Date
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
      const id = newId()
      const rows = await db
        .insert(listings)
        .values({
          id,
          listingNo: await reserveTestListingNo(db, id),
          sellerId,
          title: `集成测试商品 ${index}`,
          description: '集成测试描述',
          priceCents: 1000 + index,
          category: 'DIGITAL',
          condition: 'GOOD',
          ...(spec.status ? { status: spec.status } : {}),
          ...(spec.moderationStatus ? { moderationStatus: spec.moderationStatus } : {}),
          ...(spec.governanceDelistedAt ? { governanceDelistedAt: spec.governanceDelistedAt } : {}),
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
      'signature',
    ])
  })
})

test('findPublicUser 对不存在的用户返回 null', async () => {
  expect(await store.findPublicUser('01930000-0000-7000-8000-0000000000ff')).toBeNull()
})

test('已注销账号在公开读模型里与"不存在"同义：只有 DELETED 才对外消失（#464）', async () => {
  await withSeller([{}], async ({ sellerId }) => {
    // 先确认注销前读得到：否则这条测试无法区分"被过滤"与"从来读不到"。
    expect(await store.findPublicUser(sellerId)).not.toBeNull()

    // 冷静期内（DELETION_REQUESTED）主页仍可读——#464 只对到期去标识化后的账号隐藏。
    await db
      .update(users)
      .set({
        accountStatus: 'DELETION_REQUESTED',
        deletionRequestedAt: new Date(),
        purgeScheduledAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      })
      .where(eq(users.id, sellerId))
    expect(await store.findPublicUser(sellerId)).not.toBeNull()

    // 到期去标识化：昵称就地改写为占位，两个时间戳按 CHECK 约束清空。
    await db
      .update(users)
      .set({
        accountStatus: 'DELETED',
        deletionRequestedAt: null,
        purgeScheduledAt: null,
        nickname: DELETED_ACCOUNT_NICKNAME,
      })
      .where(eq(users.id, sellerId))
    expect(await store.findPublicUser(sellerId)).toBeNull()

    // 只是"投影读不到"，行还在：历史引用（商品卡、聊天、订单）靠这行显示占位昵称。
    const rows = await db
      .select({ nickname: users.nickname })
      .from(users)
      .where(eq(users.id, sellerId))
    expect(rows[0]?.nickname).toBe(DELETED_ACCOUNT_NICKNAME)
  })
})

test('stats：在售只算 ACTIVE + APPROVED，已售出与列表同源（SOLD 且未治理下架）', async () => {
  const base = new Date('2026-09-01T00:00:00.000Z')
  await withSeller(
    [
      { status: 'SOLD' },
      { status: 'RESERVED' },
      { status: 'ACTIVE' },
      // 审核未通过的 ACTIVE 商品不能算进"在售"（公开可见性的第二道闸）。
      { status: 'ACTIVE', moderationStatus: 'REVIEW' },
      { status: 'ACTIVE' },
      // 平台已下架之后才被核销的商品：库里 `status = 'SOLD'`，但公开列表不返回它
      // （核销路径无条件置 SOLD，只留 `governance_delisted_at` 痕迹）。计数必须一起筛掉，
      // 否则段头写「已售出 2 件」而点进去只有 1 件 —— #565 复核 M1。
      {
        status: 'SOLD',
        moderationStatus: 'BLOCKED',
        governanceDelistedAt: base,
      },
    ],
    async ({ sellerId }) => {
      const soldRows = await store.listListings(sellerId, 'SOLD', 20, null)
      const stats = await store.stats(sellerId)

      expect(stats.activeListings).toBe(2)
      // 段头数与段内条数必须相等：两个数据源（transactions / listings）就会在这里崩。
      expect(stats.soldCount).toBe(soldRows.length)
      expect(stats.soldCount).toBe(1)
    },
  )
})

test("listListings(…, 'ACTIVE', …) 只出 ACTIVE + APPROVED，时间倒序，且与 stats 的在售数一致", async () => {
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
    async ({ sellerId, buyerId, listingIds }) => {
      const rows = await store.listListings(sellerId, 'ACTIVE', 20, null)

      expect(rows.map((row) => row.id)).toEqual([listingIds[3] as string, listingIds[4] as string])
      expect(rows.every((row) => row.status === 'ACTIVE')).toBe(true)
      expect(rows.every((row) => /^[1-9][0-9]{11}$/.test(row.listingNo.toString()))).toBe(true)
      expect((await store.stats(sellerId)).activeListings).toBe(rows.length)
      // #191：卡片卖家公开子集随 join users 带出——卖家即本主页用户（真实昵称、UNVERIFIED 默认值）。
      expect(rows[0]?.seller).toEqual({
        id: sellerId,
        nickname: '卖家',
        avatarUrl: null,
        authStatus: 'UNVERIFIED',
      })

      // 浏览量（近 30 天去重浏览人数）：卡片上与「想要数」并列的另一个计数，同一个主查询带出。
      // 两个**不同**用户看过 listingIds[3] → 2；另一件在售商品没人看过 → 0（0 是事实，不是没查）。
      const viewed = listingIds[3] as string
      const untouched = listingIds[4] as string
      await db.insert(recommendationEvents).values([
        {
          eventId: newId(),
          userId: sellerId,
          listingId: viewed,
          eventType: 'DETAIL_VIEW',
          occurredAt: sql`now()`,
        },
        {
          eventId: newId(),
          userId: buyerId,
          listingId: viewed,
          eventType: 'DETAIL_VIEW',
          occurredAt: sql`now()`,
        },
      ])
      const after = await store.listListings(sellerId, 'ACTIVE', 20, null)
      const viewsOf = (id: string) => after.find((row) => row.id === id)?.views
      expect(viewsOf(viewed)).toBe(2)
      expect(viewsOf(untouched)).toBe(0)
    },
  )
})

test("listListings(…, 'SOLD', …) 只出 SOLD，筛掉平台已下架，且不叠加 moderationStatus（#565）", async () => {
  await withSeller(
    [
      { status: 'SOLD', createdAt: new Date('2026-09-09T00:00:00.000Z') },
      // 平台已下架之后才被核销：`status` 是 SOLD、`governance_delisted_at` 非空。
      // 这类商品对非本人详情一律 404，绝不能进公开列表 —— 匿名访客会拿到它的
      // 标题 / 价格 / 封面，点进去却是 404（#565 复核 H1）。
      {
        status: 'SOLD',
        moderationStatus: 'BLOCKED',
        governanceDelistedAt: new Date('2026-09-08T12:00:00.000Z'),
        createdAt: new Date('2026-09-08T00:00:00.000Z'),
      },
      { status: 'OFFLINE', createdAt: new Date('2026-09-07T00:00:00.000Z') },
      { status: 'RESERVED', createdAt: new Date('2026-09-06T00:00:00.000Z') },
      { status: 'ACTIVE', createdAt: new Date('2026-09-05T00:00:00.000Z') },
    ],
    async ({ sellerId, listingIds }) => {
      const rows = await store.listListings(sellerId, 'SOLD', 20, null)

      // 已售出段**永不**返回 OFFLINE / RESERVED / ACTIVE，也不返回平台已下架的 SOLD（#565 验收）。
      expect(rows.map((row) => row.id)).toEqual([listingIds[0] as string])
      // 段内条数与段头计数同源同条件：被筛掉的那件不能还写在段头。
      expect(await store.stats(sellerId)).toEqual({ activeListings: 1, soldCount: 1 })
    },
  )
})

test("listListings(…, 'SOLD', …) 不叠加审核列（防御性：该组合生产上不可达）", async () => {
  await withSeller(
    [
      // **防御性用例**：`status = 'SOLD'` 且 `moderation_status != 'APPROVED'` 这个组合在生产上
      // 不可达 —— 新建商品只有送审才写 OFFLINE + REVIEW（`listings/store.ts:582`）、编辑送审
      // 同理（`listings/service.ts:845`）、发起交易只认 ACTIVE（`transactions/store.ts:402`）、
      // 治理下架只从 APPROVED 下架（`governance/service.ts:296`）且恢复时 `moderation_status`
      // 取 delist 审计里的 before 值（`:387` / `:565-574`）。
      // 留在这里是防未来变化：已售出段若哪天开始叠加审核列，审核/治理期间的成交会凭空消失在
      // 他人的「已售出」里，而页头的「卖出 N」还算着它。
      { status: 'SOLD', moderationStatus: 'BLOCKED' },
    ],
    async ({ sellerId, listingIds }) => {
      const rows = await store.listListings(sellerId, 'SOLD', 20, null)

      expect(rows.map((row) => row.id)).toEqual([listingIds[0] as string])
      expect(await store.stats(sellerId)).toEqual({ activeListings: 0, soldCount: 1 })
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
      const firstFetch = await store.listListings(sellerId, 'ACTIVE', 2, null)
      expect(firstFetch).toHaveLength(3)

      const lastReturned = firstFetch[1]
      if (!lastReturned) throw new Error('第一页应当有第二行')

      const secondPage = await store.listListings(sellerId, 'ACTIVE', 2, {
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
      const rows = await store.listListings(sellerId, 'ACTIVE', 20, null)
      const byId = new Map(rows.map((row) => [row.id, row]))

      expect(byId.get(listingIds[0] as string)?.coverObjectKey).toBe('listings/cover.jpg')
      expect(byId.get(listingIds[1] as string)?.coverObjectKey).toBeNull()
    },
  )
})
