import { expect, test } from 'bun:test'
import type { ReportTargetType } from '@fish/contracts/reports/schema'
import { createDb } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { comments } from '@fish/db/schema/comments'
import { listings } from '@fish/db/schema/listings'
import { matches } from '@fish/db/schema/matches'
import { reports } from '@fish/db/schema/reports'
import { transactionReviewImages, transactionReviews } from '@fish/db/schema/transaction-reviews'
import { transactions } from '@fish/db/schema/transactions'
import { users } from '@fish/db/schema/users'
import { wishes } from '@fish/db/schema/wishes'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { decodePublicId, encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { eq, inArray } from 'drizzle-orm'
import { createReportService, ReportServiceError } from './service'
import { createSqlReportStore } from './store'

// 与 packages/db 的集成测试同一约定：没有 DATABASE_URL 就明确失败，而不是静默跳过。
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const db = createDb(databaseUrl)
const service = createReportService(createSqlReportStore(db))

type Fixture = {
  sellerId: string
  buyerId: string
  strangerId: string
  listingId: string
  /** 买家在卖家商品下的留言（卖家可举报）。 */
  commentId: string
  transactionId: string
  /** 买家写给该交易的评价（卖家可举报）。 */
  reviewId: string
  /** 陌生人发布的愿望；卖家商品与它有一条匹配（只有卖家可举报）。 */
  wishId: string
}

async function createUser(nickname: string): Promise<string> {
  const rows = await db.insert(users).values({ nickname }).returning({ id: users.id })
  const row = rows[0]
  if (!row) throw new Error('insert users 未返回行')
  return row.id
}

/**
 * 一套覆盖三种新目标的 fixture：商品 + 留言（买家写）、已完成交易 + 评价（买家写）、
 * 陌生人的愿望 + 卖家商品与它的匹配。每个用例自建、自清，避免跨用例串状态。
 */
async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const sellerId = await createUser('卖家')
  const buyerId = await createUser('买家')
  const strangerId = await createUser('陌生人')

  const listingInternalId = newId()
  const listingRows = await db
    .insert(listings)
    .values({
      id: listingInternalId,
      listingNo: await reserveTestListingNo(db, listingInternalId),
      sellerId,
      title: '集成测试商品',
      description: '集成测试描述',
      priceCents: 16000,
      category: 'DIGITAL',
      condition: 'GOOD',
    })
    .returning({ id: listings.id })
  const listingId = listingRows[0]?.id
  if (!listingId) throw new Error('insert listings 未返回行')

  const commentId = newId()
  await db.insert(comments).values({
    id: commentId,
    listingId,
    authorId: buyerId,
    parentId: null,
    content: '加我微信，私下转账',
  })

  const transactionId = newId()
  await db.insert(transactions).values({
    id: transactionId,
    listingId,
    buyerId,
    sellerId,
    amountCents: 16000,
    status: 'COMPLETED',
    completedAt: new Date('2026-10-01T11:02:00.000Z'),
  })

  const reviewId = newId()
  await db.insert(transactionReviews).values({
    id: reviewId,
    transactionId,
    authorId: buyerId,
    rating: 'POSITIVE',
    body: '东西不错，就是迟到了半小时',
  })
  await db.insert(transactionReviewImages).values([
    { reviewId, objectKey: 'reviews/first.jpg', sortOrder: 0 },
    { reviewId, objectKey: 'reviews/second.jpg', sortOrder: 1 },
  ])

  const wishId = newId()
  await db.insert(wishes).values({
    id: wishId,
    userId: strangerId,
    keyword: '机械键盘',
    category: 'DIGITAL',
    budgetMinCents: 10000,
    budgetMaxCents: 20000,
    description: '希望成色好一点',
  })
  await db.insert(matches).values({
    listingId,
    wishId,
    score: 90,
    categoryScore: 100,
    keywordScore: 80,
    priceScore: 90,
  })

  try {
    await run({
      sellerId,
      buyerId,
      strangerId,
      listingId,
      commentId,
      transactionId,
      reviewId,
      wishId,
    })
  } finally {
    // 举报行只对 reporter 有 FK：先删举报，再按「评价 → 交易 → 愿望 → 商品 → 用户」的顺序清。
    await db.delete(reports).where(inArray(reports.reporterId, [sellerId, buyerId, strangerId]))
    await db.delete(transactionReviews).where(eq(transactionReviews.transactionId, transactionId))
    await db.delete(transactions).where(eq(transactions.id, transactionId))
    await db.delete(wishes).where(eq(wishes.id, wishId))
    await db.delete(listings).where(eq(listings.id, listingId))
    await db.delete(users).where(inArray(users.id, [sellerId, buyerId, strangerId]))
  }
}

function publicId(prefix: string, rawId: string): string {
  return encodePublicId(prefix as Parameters<typeof encodePublicId>[0], rawId)
}

function reportInput(targetType: ReportTargetType, targetId: string, reason = 'SPAM') {
  return { targetType, targetId, reason, detailText: null }
}

/** 断言服务错误码与状态（不同目标的存在性/权限必须收敛到同一组对外错误）。 */
async function expectReportError(
  run: Promise<unknown>,
  code: ReportServiceError['code'],
  status: ReportServiceError['status'],
): Promise<void> {
  try {
    await run
  } catch (error) {
    expect(error).toBeInstanceOf(ReportServiceError)
    const serviceError = error as ReportServiceError
    expect(serviceError.code).toBe(code)
    expect(serviceError.status).toBe(status)
    return
  }
  throw new Error(`期望抛出 ${code}，实际成功返回`)
}

test('COMMENT：正常举报落库服务端快照，目标删除后管理端仍能读到证据', async () => {
  await withFixture(async ({ sellerId, buyerId, listingId, commentId }) => {
    const created = await service.createReport(sellerId, reportInput('COMMENT', commentId))

    expect(created.created).toBe(true)
    expect(created.report.targetType).toBe('COMMENT')

    // 举报创建响应是公共读模型（不含取证），快照只在管理端详情可见。
    const rawReportId = decodePublicId(PUBLIC_ID_PREFIX.report, created.report.id)
    const detail = await service.getAdminReport(rawReportId)
    expect(detail.item.evidence).toMatchObject({
      targetType: 'COMMENT',
      author: { id: publicId(PUBLIC_ID_PREFIX.user, buyerId) },
      listingId: publicId(PUBLIC_ID_PREFIX.listing, listingId),
      parentId: null,
      content: '加我微信，私下转账',
    })

    // 快照来自服务端读取的目标行（jsonb），不是客户端提交的内容。
    const [row] = await db
      .select({ evidence: reports.evidenceSnapshot })
      .from(reports)
      .where(eq(reports.id, rawReportId))
    expect(row?.evidence).toMatchObject({
      targetType: 'COMMENT',
      authorId: buyerId,
      content: '加我微信，私下转账',
    })

    // 留言被作者删除后：公共读侧不再有它，但管理端详情仍拿得到取证快照。
    await db.delete(comments).where(eq(comments.id, commentId))
    const afterDelete = await service.getAdminReport(rawReportId)
    expect(afterDelete.item.target.label).toBe('目标已删除')
    expect(afterDelete.item.evidence).toMatchObject({
      targetType: 'COMMENT',
      content: '加我微信，私下转账',
    })
  })
})

test('COMMENT：举报自己的留言 422，举报不存在的留言 404', async () => {
  await withFixture(async ({ buyerId, commentId }) => {
    await expectReportError(
      service.createReport(buyerId, reportInput('COMMENT', commentId, 'HARASSMENT')),
      'REPORT_SELF_TARGET',
      422,
    )
    await expectReportError(
      service.createReport(buyerId, reportInput('COMMENT', newId())),
      'REPORT_TARGET_NOT_FOUND',
      404,
    )
  })
})

test('COMMENT：商品已下架时，非卖家举报 404、卖家举报仍成立', async () => {
  await withFixture(async ({ sellerId, strangerId, listingId, commentId }) => {
    await db.update(listings).set({ status: 'OFFLINE' }).where(eq(listings.id, listingId))

    await expectReportError(
      service.createReport(strangerId, reportInput('COMMENT', commentId)),
      'REPORT_TARGET_NOT_FOUND',
      404,
    )
    const created = await service.createReport(sellerId, reportInput('COMMENT', commentId))
    expect(created.created).toBe(true)
  })
})

test('REVIEW：交易参与者可举报对方的评价，快照含评分/正文/配图数', async () => {
  await withFixture(async ({ sellerId, buyerId, strangerId, reviewId }) => {
    const created = await service.createReport(
      sellerId,
      reportInput('REVIEW', reviewId, 'HARASSMENT'),
    )
    expect(created.created).toBe(true)
    const detail = await service.getAdminReport(
      decodePublicId(PUBLIC_ID_PREFIX.report, created.report.id),
    )
    expect(detail.item.evidence).toMatchObject({
      targetType: 'REVIEW',
      author: { id: publicId(PUBLIC_ID_PREFIX.user, buyerId) },
      rating: 'POSITIVE',
      body: '东西不错，就是迟到了半小时',
      imageCount: 2,
    })

    // 自己的评价不能举报；非交易参与者连目标存在性都不该知道（与读评价同口径的 404）。
    await expectReportError(
      service.createReport(buyerId, reportInput('REVIEW', reviewId)),
      'REPORT_SELF_TARGET',
      422,
    )
    await expectReportError(
      service.createReport(strangerId, reportInput('REVIEW', reviewId)),
      'REPORT_TARGET_NOT_FOUND',
      404,
    )
  })
})

test('REVIEW：证据媒体按 index 读取快照里的配图，越界返回 null', async () => {
  await withFixture(async ({ sellerId, reviewId }) => {
    const created = await service.createReport(sellerId, reportInput('REVIEW', reviewId))

    const rawReportId = decodePublicId(PUBLIC_ID_PREFIX.report, created.report.id)
    expect(await service.getEvidenceMedia(rawReportId, 0)).toEqual({
      objectKey: 'reviews/first.jpg',
      mimeType: null,
    })
    expect(await service.getEvidenceMedia(rawReportId, 1)).toEqual({
      objectKey: 'reviews/second.jpg',
      mimeType: null,
    })
    expect(await service.getEvidenceMedia(rawReportId, 2)).toBeNull()
  })
})

test('WISH：只有与该愿望匹配的商品卖家可举报；许愿人自己 422，无匹配者 404', async () => {
  await withFixture(async ({ sellerId, buyerId, strangerId, wishId }) => {
    const created = await service.createReport(sellerId, reportInput('WISH', wishId, 'PROHIBITED'))
    expect(created.created).toBe(true)
    const detail = await service.getAdminReport(
      decodePublicId(PUBLIC_ID_PREFIX.report, created.report.id),
    )
    expect(detail.item.evidence).toMatchObject({
      targetType: 'WISH',
      owner: { id: publicId(PUBLIC_ID_PREFIX.user, strangerId) },
      keyword: '机械键盘',
      category: 'DIGITAL',
      budgetMinCents: 10000,
      budgetMaxCents: 20000,
      status: 'ACTIVE',
      moderationStatus: 'APPROVED',
    })

    await expectReportError(
      service.createReport(strangerId, reportInput('WISH', wishId)),
      'REPORT_SELF_TARGET',
      422,
    )
    // 买家没有商品，不存在与该愿望的匹配 —— 与「目标不存在」同一出口，不暴露愿望归属。
    await expectReportError(
      service.createReport(buyerId, reportInput('WISH', wishId)),
      'REPORT_TARGET_NOT_FOUND',
      404,
    )
  })
})

test('同一举报人对同一目标的未决举报幂等：返回同一条，只落一行', async () => {
  await withFixture(async ({ sellerId, reviewId }) => {
    const targetId = reviewId
    const first = await service.createReport(sellerId, reportInput('REVIEW', targetId, 'SPAM'))
    const second = await service.createReport(
      sellerId,
      reportInput('REVIEW', targetId, 'HARASSMENT'),
    )

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.report.id).toBe(first.report.id)
    expect(second.report.reason).toBe('SPAM')

    const rows = await db
      .select({ id: reports.id })
      .from(reports)
      .where(eq(reports.reporterId, sellerId))
    expect(rows).toHaveLength(1)
  })
})
