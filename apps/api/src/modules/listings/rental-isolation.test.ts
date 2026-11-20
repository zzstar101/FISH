import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { comments } from '@fish/db/schema/comments'
import { conversations } from '@fish/db/schema/conversations'
import { favorites } from '@fish/db/schema/favorites'
import { listingImages, listings } from '@fish/db/schema/listings'
import { matches } from '@fish/db/schema/matches'
import { users } from '@fish/db/schema/users'
import { listingViewHistory } from '@fish/db/schema/view-history'
import { wishes } from '@fish/db/schema/wishes'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { createSqlCommentStore } from '../comments/store'
import { createSqlConversationStore } from '../conversations/store'
import { createFavoriteService } from '../favorites/service'
import { createSqlFavoriteStore } from '../favorites/store'
import { createSqlMatchingStore } from '../matching/store'
import { createSqlProfileStore } from '../profile/store'
import { createSqlPublicUserStore } from '../users/store'
import { createSqlViewHistoryStore } from '../view-history/store'
import { createListingService } from './service'
import { createSqlListingStore } from './store'

/**
 * #705 RNT-01 的**跨模块隔离回归**：买卖侧的每一条读 / 写入口都必须在真库上证明
 * 「RENTAL 不会以售价商品的身份出现」。
 *
 * 为什么集中在一个文件里：这些入口分散在 eight 个 store 里，而每个 store 自己的测试只覆盖
 * 它自己的语义。把它们放在一起，是为了让「某处 SALE 过滤被误删」在任何一次改动后都能被
 * 一条用例点名 —— 审查时用变异测试验证过：逐个回滚过滤，本文件会红。
 *
 * 用独立 scratch 库（`fish_rental_isolation_test_<pid>`），与仓库其它集成测试同一约定。
 */
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../../../packages/db/src/migrations', import.meta.url),
)

const scratchDatabase = `fish_rental_isolation_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const admin = createDb(databaseUrl)
const db = createDb(scratchUrl)

const listingStore = createSqlListingStore(db)
const favoriteStore = createSqlFavoriteStore(db)
const viewHistoryStore = createSqlViewHistoryStore(db)
const publicUserStore = createSqlPublicUserStore(db)
const commentStore = createSqlCommentStore(db)
const profileStore = createSqlProfileStore(db)
const matchingStore = createSqlMatchingStore(db)
const conversationStore = createSqlConversationStore(db)

const storage = {
  publicUrl: (key: string) => `https://cdn.example/${key}`,
  // 这两个由 `createListingService` 的写路径用到；本文件只读详情，给最小合法实现。
  presignPut: () => ({
    url: 'https://upload.test',
    headers: {},
    expiresAt: new Date().toISOString(),
  }),
  stat: async () => ({ size: 100, contentType: 'image/jpeg' }),
}

const sellerId = '01970000-0000-7000-8000-000000000001'
const buyerId = '01970000-0000-7000-8000-000000000002'

/** 每个用例组的商品 pair：一件 SALE、一件 RENTAL，其余字段尽可能一致。 */
let saleId = ''
let rentalId = ''
let wishId = ''

let seq = 0
const uniqueStudentNo = () => `rental-isolation-${Date.now()}-${seq++}`

async function insertListing(input: {
  sellerId: string
  title: string
  listingType: 'SALE' | 'RENTAL'
  priceCents?: number
  status?: 'ACTIVE' | 'OFFLINE' | 'RESERVED' | 'SOLD'
  moderationStatus?: 'APPROVED' | 'BLOCKED' | 'REVIEW'
}): Promise<string> {
  const id = newId()
  await db.insert(listings).values({
    id,
    listingNo: await reserveTestListingNo(db, id),
    sellerId: input.sellerId,
    title: input.title,
    description: `${input.title} 的描述`,
    priceCents: input.priceCents ?? 5000,
    category: 'DIGITAL',
    condition: 'GOOD',
    status: input.status ?? 'ACTIVE',
    moderationStatus: input.moderationStatus ?? 'APPROVED',
    listingType: input.listingType,
  })
  await db
    .insert(listingImages)
    .values({ listingId: id, objectKey: `listings/${id}/0.jpg`, sortOrder: 0 })
  return id
}

beforeAll(async () => {
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  await migrate(db, { migrationsFolder })

  for (const [id, nickname] of [
    [sellerId, '出租卖家'],
    [buyerId, '买家'],
  ] as const) {
    await db.insert(users).values({
      id,
      studentNo: uniqueStudentNo(),
      passwordHash: 'test-not-a-real-hash',
      nickname,
    })
  }

  saleId = await insertListing({ sellerId, title: '出售商品', listingType: 'SALE' })
  rentalId = await insertListing({ sellerId, title: '出租商品', listingType: 'RENTAL' })

  // 收藏 / 足迹 / 留言 / 会话都建在**两件商品**上：过滤若失效，列表里会同时出现两条。
  await db.insert(favorites).values([
    { userId: buyerId, listingId: saleId },
    { userId: buyerId, listingId: rentalId },
  ])
  await db.insert(listingViewHistory).values([
    { userId: buyerId, listingId: saleId, lastViewedAt: new Date() },
    { userId: buyerId, listingId: rentalId, lastViewedAt: new Date() },
  ])
  await db.insert(comments).values([
    { listingId: saleId, authorId: buyerId, content: '出售商品的留言' },
    { listingId: rentalId, authorId: buyerId, content: '出租商品的留言' },
  ])

  // 许愿匹配：两条匹配行（一件出售、一件出租），用于验证 list / count 两侧都过滤。
  // 三路打分列的完整性：DB 里是 NOT NULL（smallint 0–100），缺一列会直接插不进去。
  const scoreInputs = { categoryScore: 35, keywordScore: 35, priceScore: 30 }
  wishId = newId()
  await db.insert(wishes).values({
    id: wishId,
    userId: buyerId,
    keyword: '键盘',
    category: 'DIGITAL',
    budgetMinCents: 1000,
    budgetMaxCents: 100_000,
    acceptSimilar: true,
  })
  // 打分输入列在 DB 里是 NOT NULL：这里给出与打分表一致的完整投影。
  await db.insert(matches).values([
    { wishId, listingId: saleId, score: 90, ...scoreInputs },
    { wishId, listingId: rentalId, score: 95, ...scoreInputs },
  ])
})

afterAll(async () => {
  await db.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

describe('#705 买卖读路径隔离：RENTAL 不出现在出售语义的返回里', () => {
  test('listFeed：公开 Feed 与「我发布的」都只有 SALE', async () => {
    const publicRows = await listingStore.listFeed({
      limit: 20,
      cursor: null,
      sort: 'newest',
      status: 'ACTIVE',
    })
    const publicIds = publicRows.map((row) => row.listing.id)
    expect(publicIds).toContain(saleId)
    expect(publicIds).not.toContain(rentalId)

    const ownRows = await listingStore.listFeed({
      limit: 20,
      cursor: null,
      sort: 'newest',
      sellerId,
      includeUnapproved: true,
    })
    const ownIds = ownRows.map((row) => row.listing.id)
    expect(ownIds).toContain(saleId)
    expect(ownIds).not.toContain(rentalId)
  })

  test('findCardsByIds：推荐 / 识图按 id 取卡片时 RENTAL 被剔除', async () => {
    const entries = await listingStore.findCardsByIds([saleId, rentalId], { viewerUserId: null })
    const ids = entries.map((entry) => entry.listing.id)
    expect(ids).toContain(saleId)
    expect(ids).not.toContain(rentalId)
  })

  test('getDetail：出租商品按 404 处理（连卖家本人也一样）', async () => {
    const service = createListingService({ store: listingStore, storage })
    await expect(service.getDetail(null, rentalId)).rejects.toMatchObject({
      status: 404,
      code: 'LISTING_NOT_FOUND',
    })
    await expect(service.getDetail(sellerId, rentalId)).rejects.toMatchObject({
      status: 404,
      code: 'LISTING_NOT_FOUND',
    })
    // 同一接口对 SALE 正常 —— 否则上面的断言可能只是「全都 404」。
    expect((await service.getDetail(null, saleId)).id).toStartWith('lst_')
  })

  test('收藏：列表与总数都只算 SALE', async () => {
    const [rows, total] = await Promise.all([
      favoriteStore.listFavorites(buyerId, 20, null),
      favoriteStore.totalFavorites(buyerId),
    ])
    const ids = rows.map((row) => row.id)
    expect(ids).toContain(saleId)
    expect(ids).not.toContain(rentalId)
    // 计数与列表必须一致：不一致会让端上出现「写着 2 条、只列出 1 条」。
    expect(total).toBe(1)
  })

  test('收藏：收藏态 / 收藏 / 取消收藏对 RENTAL 一律 404（不开存在性探针）', async () => {
    const service = createFavoriteService({ store: favoriteStore, storage })
    const soldRental = rentalId
    await expect(service.getState(buyerId, soldRental)).rejects.toMatchObject({
      status: 404,
      code: 'LISTING_NOT_FOUND',
    })
    await expect(service.favorite(buyerId, soldRental)).rejects.toMatchObject({
      status: 404,
      code: 'LISTING_NOT_FOUND',
    })
    // SALE 侧照常：证明上面的 404 不是「全都 404」。
    expect(await service.getState(buyerId, saleId)).toEqual(
      expect.objectContaining({ favorited: true }),
    )
  })

  test('浏览足迹：列表与总数都只算 SALE', async () => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const [rows, total] = await Promise.all([
      viewHistoryStore.listViewHistory(buyerId, 20, null, since),
      viewHistoryStore.totalViewHistory(buyerId, since),
    ])
    const ids = rows.map((row) => row.id)
    expect(ids).toContain(saleId)
    expect(ids).not.toContain(rentalId)
    expect(total).toBe(1)
  })

  test('他人主页：在售列表与统计都只算 SALE', async () => {
    const [rows, stats] = await Promise.all([
      publicUserStore.listListings(sellerId, 'ACTIVE', 20, null),
      publicUserStore.stats(sellerId),
    ])
    const ids = rows.map((row) => row.id)
    expect(ids).toContain(saleId)
    expect(ids).not.toContain(rentalId)
    expect(stats.activeListings).toBe(1)
  })

  test('我发过的留言：列表与总数都只算 SALE', async () => {
    const [rows, total] = await Promise.all([
      commentStore.listByAuthor(buyerId, 20, null),
      commentStore.countByAuthor(buyerId),
    ])
    const listingIds = rows.map((row) => row.id)
    expect(listingIds).toContain(saleId)
    expect(listingIds).not.toContain(rentalId)
    expect(total).toBe(1)
  })

  test('留言端点：对 RENTAL 视为不存在（读 / 写都 404）', async () => {
    expect(await commentStore.findListingSellerId(rentalId)).toBeNull()
    expect(await commentStore.findListingSellerId(saleId)).toBe(sellerId)
  })

  test('个人中心：我发布的与在售统计都只算 SALE', async () => {
    const [rows, stats] = await Promise.all([
      profileStore.ownListings(sellerId, 20),
      profileStore.stats(sellerId),
    ])
    const ids = rows.map((row) => row.id)
    expect(ids).toContain(saleId)
    expect(ids).not.toContain(rentalId)
    expect(stats.activeListings).toBe(1)
  })

  test('许愿匹配：列表与计数都只算 SALE（两者必须逐字一致）', async () => {
    const [entries, total] = await Promise.all([
      matchingStore.listWishMatches(wishId, 20),
      matchingStore.countWishMatches(wishId),
    ])
    const ids = entries.map((entry) => entry.listing.id)
    expect(ids).toContain(saleId)
    expect(ids).not.toContain(rentalId)
    expect(total).toBe(1)
  })

  test('会话：出租商品建不了买卖会话（读取行即按不存在处理）', async () => {
    expect(await conversationStore.findListingBrief(rentalId)).toBeNull()
    expect(await conversationStore.findListingBrief(saleId)).not.toBeNull()
  })

  test('重复发布窗口：同名的出租商品不会把一次合法的出售发布判成重复', async () => {
    // 只让**出租**那一件落在查重窗口里：标题 / 价格 / 分类三者与下面这次发布完全相同。
    // 没有类型条件时，createListingAtomic 会把它判成 duplicate，返回一个 `getDetail` 里 404
    // 的 id —— 用户的合法发布变成「商品不存在」。
    const twinRental = await insertListing({
      sellerId,
      title: '撞名出租商品',
      listingType: 'RENTAL',
      priceCents: 12_345,
    })
    try {
      const created = await listingStore.createListingAtomic({
        id: newId(),
        sellerId,
        title: '撞名出租商品',
        description: '撞名出租商品 的描述',
        priceCents: 12_345,
        category: 'DIGITAL',
        condition: 'GOOD',
        urgent: false,
        negotiable: false,
        free: false,
        objectKeys: [`listings/${sellerId}/dup.jpg`],
        duplicateWindowStart: new Date(Date.now() - 60_000),
      })
      expect(created.kind).toBe('created')
      // 反向对照：同标题同价的**出售**商品仍在窗口内 → 真正的重复提交必须被识别。
      const again = await listingStore.createListingAtomic({
        id: newId(),
        sellerId,
        title: '撞名出租商品',
        description: '撞名出租商品 的描述',
        priceCents: 12_345,
        category: 'DIGITAL',
        condition: 'GOOD',
        urgent: false,
        negotiable: false,
        free: false,
        objectKeys: [`listings/${sellerId}/dup2.jpg`],
        duplicateWindowStart: new Date(Date.now() - 60_000),
      })
      expect(again.kind).toBe('duplicate')
    } finally {
      await db.delete(listings).where(inArray(listings.id, [twinRental]))
    }
  })
})

describe('#705 旧写端点不对 RENTAL 生效', () => {
  test('transition / deleteListing 对 RENTAL 返回 404 且不改库', async () => {
    const service = createListingService({ store: listingStore, storage })
    const target = await insertListing({ sellerId, title: '待改写出租', listingType: 'RENTAL' })
    try {
      await expect(service.transition(sellerId, target, 'OFFLINE')).rejects.toMatchObject({
        status: 404,
        code: 'LISTING_NOT_FOUND',
      })
      const [afterOffline] = await db
        .select({ status: listings.status })
        .from(listings)
        .where(eq(listings.id, target))
      // 关键：报 404 **且**库里没被改。先写后判会让接口谎报失败、写入却生效。
      expect(afterOffline?.status).toBe('ACTIVE')

      await expect(service.deleteListing(sellerId, target)).rejects.toMatchObject({
        status: 404,
        code: 'LISTING_NOT_FOUND',
      })
      expect(await db.$count(listings, eq(listings.id, target))).toBe(1)

      // 编辑同样拒绝。这里除了断言错误码，还要断言**库里没被改** —— 「锁内改完再在
      // `loadDetail` 里 404」同样满足「抛 404」，只断言错误码对这类变异是盲的。
      await expect(
        service.updateListing(sellerId, target, { title: '改个名' }),
      ).rejects.toMatchObject({ status: 404, code: 'LISTING_NOT_FOUND' })
      const [afterUpdate] = await db
        .select({ title: listings.title })
        .from(listings)
        .where(eq(listings.id, target))
      expect(afterUpdate?.title).toBe('待改写出租')
    } finally {
      await db.delete(listingImages).where(eq(listingImages.listingId, target))
      await db.delete(listings).where(inArray(listings.id, [target]))
    }
  })

  test('上下架的条件更新带类型：RENTAL 即使绕过 service 也改不动状态', async () => {
    const target = await insertListing({ sellerId, title: '条件更新出租', listingType: 'RENTAL' })
    try {
      // 直接走 store：0 行 ⇒ false，状态保持 ACTIVE。
      expect(await listingStore.setStatus({ id: target, from: 'ACTIVE', to: 'OFFLINE' })).toBe(
        false,
      )
      const [after] = await db
        .select({ status: listings.status })
        .from(listings)
        .where(eq(listings.id, target))
      expect(after?.status).toBe('ACTIVE')
    } finally {
      await db.delete(listingImages).where(eq(listingImages.listingId, target))
      await db.delete(listings).where(inArray(listings.id, [target]))
    }
  })
})
