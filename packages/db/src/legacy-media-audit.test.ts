import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createDb, type Db } from './client'
import {
  finalizeLegacyMediaAudit,
  findLegacyMediaAuditItem,
  isLegacyMediaPubliclyReadable,
  isLegacyMediaReadableByViewer,
  listLegacyMediaAuditCandidates,
  loadLegacyMediaAuditDecisions,
  markLegacyMediaAuditFailure,
  requeueFailedLegacyMediaAudit,
  summarizeLegacyMediaInventory,
  syncLegacyMediaInventory,
  syncLegacyMediaInventoryBatch,
} from './legacy-media-audit'
import { conversations } from './schema/conversations'
import { listingMediaObjects } from './schema/listing-media'
import { listingImages, listings } from './schema/listings'
import { messageMedia } from './schema/message-media'
import { messages } from './schema/messages'
import { listingModerationRecords } from './schema/moderation'
import { transactionReviewImages, transactionReviews } from './schema/transaction-reviews'
import { transactions } from './schema/transactions'
import { users } from './schema/users'
import { reserveTestListingNo } from './testing/listing-no'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const scratchDatabase = `fish_legacy_media_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()
const migrationsFolder = new URL('./migrations', import.meta.url).pathname

const adminDb = createDb(databaseUrl)
let db: Db

const SELLER_ID = '01930000-0000-4000-8000-000000000101'
const BUYER_ID = '01930000-0000-4000-8000-000000000102'
const ADMIN_ID = '01930000-0000-4000-8000-000000000103'
const OUTSIDER_ID = '01930000-0000-4000-8000-000000000104'

// 商品图：raw UUID 前缀 = 历史遗留直读键。
const LEGACY_KEY = 'listings/01930000-0000-4000-8000-0000000000a1/legacy.jpg'
const BLOCK_KEY = 'listings/01930000-0000-4000-8000-0000000000a2/block.jpg'
const FAIL_KEY = 'listings/01930000-0000-4000-8000-0000000000a3/failed.jpg'
// 已有台账行 → 不属于补审范围。
const LEDGERED_KEY = 'listings/01930000-0000-4000-8000-0000000000a4/ledgered.jpg'
const REVIEW_KEY = 'reviews/01930000-0000-4000-8000-0000000000b1/photo.png'
const CHAT_KEY = `chat-media-final/${'01930000-0000-4000-8000-0000000000c1'}/${BUYER_ID}/photo.png`

const LISTING_1 = '01930000-0000-4000-8000-000000000201'
const LISTING_2 = '01930000-0000-4000-8000-000000000202'
const LISTING_3 = '01930000-0000-4000-8000-000000000203'
const TRANSACTION_ID = '01930000-0000-4000-8000-000000000301'
const REVIEW_ID = '01930000-0000-4000-8000-000000000401'
const CONVERSATION_ID = '01930000-0000-4000-8000-000000000501'
const MESSAGE_ID = '01930000-0000-4000-8000-000000000601'

beforeAll(async () => {
  await adminDb.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await adminDb.$client.unsafe(`create database "${scratchDatabase}"`)
  db = createDb(scratchUrl)
  await migrate(db, { migrationsFolder })

  await db.insert(users).values([
    { id: SELLER_ID, nickname: '卖家' },
    { id: BUYER_ID, nickname: '买家' },
    { id: ADMIN_ID, nickname: '管理员', role: 'ADMIN' },
    { id: OUTSIDER_ID, nickname: '路人' },
  ])

  for (const [id, title] of [
    [LISTING_1, '商品一'],
    [LISTING_2, '商品二'],
    [LISTING_3, '商品三'],
  ] as const) {
    const listingNo = await reserveTestListingNo(db, id)
    await db.insert(listings).values({
      id,
      listingNo,
      sellerId: SELLER_ID,
      title,
      description: '描述',
      priceCents: 100,
      category: 'OTHER',
      condition: 'GOOD',
    })
  }

  // 同一张遗留图被两个商品引用；第三张图属于第三个商品。
  await db.insert(listingImages).values([
    { listingId: LISTING_1, objectKey: LEGACY_KEY, sortOrder: 0 },
    { listingId: LISTING_2, objectKey: LEGACY_KEY, sortOrder: 0 },
    { listingId: LISTING_3, objectKey: BLOCK_KEY, sortOrder: 0 },
    { listingId: LISTING_3, objectKey: FAIL_KEY, sortOrder: 1 },
    { listingId: LISTING_3, objectKey: LEDGERED_KEY, sortOrder: 2 },
  ])
  await db.insert(listingMediaObjects).values({
    userId: SELLER_ID,
    stagingKey: 'listing-media/seed/staging.jpg',
    finalKey: LEDGERED_KEY,
    contentDigest: 'a'.repeat(64),
    moderationDecision: 'ALLOW',
    provider: 'LOCAL',
  })

  await db.insert(transactions).values({
    id: TRANSACTION_ID,
    listingId: LISTING_1,
    buyerId: BUYER_ID,
    sellerId: SELLER_ID,
    amountCents: 100,
    status: 'COMPLETED',
    completedAt: new Date(),
  })
  await db.insert(transactionReviews).values({
    id: REVIEW_ID,
    transactionId: TRANSACTION_ID,
    authorId: BUYER_ID,
    rating: 'POSITIVE',
  })
  await db.insert(transactionReviewImages).values({
    reviewId: REVIEW_ID,
    objectKey: REVIEW_KEY,
    sortOrder: 0,
  })

  await db.insert(conversations).values({
    id: CONVERSATION_ID,
    listingId: LISTING_1,
    buyerId: BUYER_ID,
    sellerId: SELLER_ID,
  })
  await db.insert(messages).values({
    id: MESSAGE_ID,
    conversationId: CONVERSATION_ID,
    senderId: BUYER_ID,
    type: 'MEDIA',
    content: '',
  })
  await db.insert(messageMedia).values({
    messageId: MESSAGE_ID,
    conversationId: CONVERSATION_ID,
    ownerId: BUYER_ID,
    kind: 'IMAGE',
    objectKey: CHAT_KEY,
    mimeType: 'image/png',
    sizeBytes: 3,
    width: 1,
    height: 1,
  })
})

afterAll(async () => {
  if (db) await db.$client.close()
  await adminDb.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await adminDb.$client.close()
})

describe('legacy media inventory', () => {
  test('盘点商品 / 评价 / 聊天图，排除已有台账的对象，重复运行稳定', async () => {
    // 批次 + 游标断续执行：每批独立提交，下一批从 afterKey 之后继续。
    const batch1 = await syncLegacyMediaInventoryBatch(db, { limit: 2 })
    expect(batch1.scanned).toBe(2)
    expect(batch1.nextCursor).not.toBeNull()
    const batch2 = await syncLegacyMediaInventoryBatch(db, {
      limit: 2,
      afterKey: batch1.nextCursor,
    })
    expect(batch2.scanned).toBe(2)
    const batch3 = await syncLegacyMediaInventoryBatch(db, {
      limit: 2,
      afterKey: batch2.nextCursor,
    })
    expect(batch3.scanned).toBe(1)
    expect(batch3.nextCursor).not.toBeNull()
    const batch4 = await syncLegacyMediaInventoryBatch(db, {
      limit: 2,
      afterKey: batch3.nextCursor,
    })
    expect(batch4.scanned).toBe(0)
    expect(batch4.nextCursor).toBeNull()

    const first = await syncLegacyMediaInventory(db)
    expect(first.scanned).toBe(5)
    const second = await syncLegacyMediaInventory(db)
    expect(second.scanned).toBe(5)

    const legacy = await findLegacyMediaAuditItem(db, LEGACY_KEY)
    expect(legacy).not.toBeNull()
    expect(legacy?.sourceKind).toBe('LISTING')
    expect(legacy?.publicVisibility).toBe('LEGACY_PROXY')
    expect(legacy?.existingDecision).toBeNull()
    expect(legacy?.referenceCount).toBe(2)
    expect(legacy?.listingReferenceCount).toBe(2)
    expect(legacy?.ownerCount).toBe(1)
    expect(legacy?.sourceRefs).toHaveLength(2)

    const review = await findLegacyMediaAuditItem(db, REVIEW_KEY)
    expect(review?.sourceKind).toBe('REVIEW')
    expect(review?.publicVisibility).toBe('PRIVATE_PROXY')
    expect(review?.sourceRefs).toHaveLength(1)

    const chat = await findLegacyMediaAuditItem(db, CHAT_KEY)
    expect(chat?.sourceKind).toBe('CHAT')
    expect(chat?.publicVisibility).toBe('PRIVATE')
    expect(chat?.existingDecision).toBeNull()

    // 已有 listing_media_objects 台账的键不是存量补审对象。
    expect(await findLegacyMediaAuditItem(db, LEDGERED_KEY)).toBeNull()

    const summary = await summarizeLegacyMediaInventory(db)
    expect(summary.total).toBe(5)
    expect(summary.byStatus.PENDING).toBe(5)
    expect(summary.bySourceKind).toEqual({ LISTING: 3, REVIEW: 1, CHAT: 1 })

    const candidates = await listLegacyMediaAuditCandidates(db, { limit: 10 })
    expect(candidates).toHaveLength(5)
    expect(candidates.map((item) => item.objectKey)).toContain(LEGACY_KEY)
  })

  test('REVIEW / BLOCK 收口商品可见性并写入管理队列；ALLOW 保持公开', async () => {
    const review = await finalizeLegacyMediaAudit(db, {
      objectKey: LEGACY_KEY,
      sourceKind: 'LISTING',
      decision: 'REVIEW',
      provider: 'LOCAL',
      providerRequestId: null,
      policyVersion: 'legacy-media-audit-test',
      suggestion: 'Review',
      label: null,
      subLabel: null,
      score: null,
      contentDigest: 'b'.repeat(64),
      sizeBytes: 10,
      mimeType: 'image/jpeg',
    })
    expect(review.status).toBe('audited')
    expect(review.listingsAffected).toBe(2)

    const reviewedListings = await db
      .select({ id: listings.id, moderationStatus: listings.moderationStatus })
      .from(listings)
      .where(eq(listings.sellerId, SELLER_ID))
    expect(reviewedListings.filter((row) => row.moderationStatus === 'REVIEW')).toHaveLength(2)

    const records = await db
      .select({ id: listingModerationRecords.id })
      .from(listingModerationRecords)
      .where(eq(listingModerationRecords.action, 'LEGACY_MEDIA_AUDIT'))
    expect(records).toHaveLength(2)

    // 幂等：同一对象再次补审不再写记录，也不重复改商品。
    const again = await finalizeLegacyMediaAudit(db, {
      objectKey: LEGACY_KEY,
      sourceKind: 'LISTING',
      decision: 'BLOCK',
      provider: 'LOCAL',
      providerRequestId: null,
      policyVersion: 'legacy-media-audit-test',
      suggestion: 'Block',
      label: null,
      subLabel: null,
      score: null,
      contentDigest: 'b'.repeat(64),
      sizeBytes: 10,
      mimeType: 'image/jpeg',
    })
    expect(again.status).toBe('already_audited')
    expect(again.decision).toBe('REVIEW')
    expect(await countModerationRecords()).toBe(2)

    expect(await isLegacyMediaPubliclyReadable(db, LEGACY_KEY)).toBe(false)

    const blocked = await finalizeLegacyMediaAudit(db, {
      objectKey: BLOCK_KEY,
      sourceKind: 'LISTING',
      decision: 'BLOCK',
      provider: 'LOCAL',
      providerRequestId: null,
      policyVersion: 'legacy-media-audit-test',
      suggestion: 'Block',
      label: null,
      subLabel: null,
      score: null,
      contentDigest: 'c'.repeat(64),
      sizeBytes: 10,
      mimeType: 'image/jpeg',
    })
    expect(blocked.listingsAffected).toBe(1)
    const [third] = await db
      .select({ moderationStatus: listings.moderationStatus })
      .from(listings)
      .where(eq(listings.id, LISTING_3))
    expect(third?.moderationStatus).toBe('BLOCKED')
    expect(await isLegacyMediaPubliclyReadable(db, BLOCK_KEY)).toBe(false)

    const allowed = await finalizeLegacyMediaAudit(db, {
      objectKey: CHAT_KEY,
      sourceKind: 'CHAT',
      decision: 'ALLOW',
      provider: 'LOCAL',
      providerRequestId: null,
      policyVersion: 'legacy-media-audit-test',
      suggestion: 'Pass',
      label: null,
      subLabel: null,
      score: null,
      contentDigest: 'd'.repeat(64),
      sizeBytes: 3,
      mimeType: 'image/png',
    })
    expect(allowed.status).toBe('audited')
    expect(await isLegacyMediaPubliclyReadable(db, CHAT_KEY)).toBe(true)

    // 未盘点到的新键沿用历史兼容（可读）；盘点到未出结论的键 fail-closed。
    expect(await isLegacyMediaPubliclyReadable(db, 'listings/not-inventoried.jpg')).toBe(true)
    expect(await isLegacyMediaPubliclyReadable(db, FAIL_KEY)).toBe(false)

    const decisions = await loadLegacyMediaAuditDecisions(db, [LEGACY_KEY, CHAT_KEY, FAIL_KEY])
    expect(decisions.get(LEGACY_KEY)).toBe('REVIEW')
    expect(decisions.get(CHAT_KEY)).toBe('ALLOW')
    expect(decisions.get(FAIL_KEY)).toBe('REVIEW')
    expect(decisions.has('listings/not-inventoried.jpg')).toBe(false)
  })

  test('可重试失败保持 PENDING 并按退避重排，永久失败转 FAILED', async () => {
    const retry = await markLegacyMediaAuditFailure(db, {
      objectKey: FAIL_KEY,
      error: 'upstream timeout',
      retryable: true,
      maxAttempts: 3,
      retryDelayMs: 60_000,
    })
    expect(retry?.auditStatus).toBe('PENDING')
    expect(retry?.attempts).toBe(1)

    const pending = await listLegacyMediaAuditCandidates(db, { limit: 10, maxAttempts: 3 })
    expect(pending.some((item) => item.objectKey === FAIL_KEY)).toBe(false)

    const failed = await markLegacyMediaAuditFailure(db, {
      objectKey: FAIL_KEY,
      error: 'invalid upstream response',
      retryable: false,
      maxAttempts: 3,
    })
    expect(failed?.auditStatus).toBe('FAILED')
    expect(failed?.attempts).toBe(2)

    const item = await findLegacyMediaAuditItem(db, FAIL_KEY)
    expect(item?.lastError).toBe('invalid upstream response')
    expect(await isLegacyMediaPubliclyReadable(db, FAIL_KEY)).toBe(false)
  })
})

describe('legacy media 读侧授权与失败重排', () => {
  test('卖家 / 管理员 / 交易当事人可读，路人不可读', async () => {
    // LEGACY_KEY 属于 LISTING_1（SELLER_ID 的商品），且有一笔 BUYER_ID 的交易。
    expect(await isLegacyMediaReadableByViewer(db, LEGACY_KEY, SELLER_ID)).toBe(true)
    expect(await isLegacyMediaReadableByViewer(db, LEGACY_KEY, ADMIN_ID)).toBe(true)
    expect(await isLegacyMediaReadableByViewer(db, LEGACY_KEY, BUYER_ID)).toBe(true)
    expect(await isLegacyMediaReadableByViewer(db, LEGACY_KEY, OUTSIDER_ID)).toBe(false)
    // 未知用户 id 不能冒充任何身份。
    expect(
      await isLegacyMediaReadableByViewer(db, LEGACY_KEY, '01930000-0000-4000-8000-0000000001ff'),
    ).toBe(false)
  })

  test('FAILED 记录可按数量 / 时间重排回 PENDING', async () => {
    const failed = await findLegacyMediaAuditItem(db, FAIL_KEY)
    expect(failed?.auditStatus).toBe('FAILED')

    const requeued = await requeueFailedLegacyMediaAudit(db, { limit: 10 })
    expect(requeued.requeued).toBeGreaterThanOrEqual(1)

    const item = await findLegacyMediaAuditItem(db, FAIL_KEY)
    expect(item?.auditStatus).toBe('PENDING')
    expect(item?.attempts).toBe(0)
    expect(item?.lastError).toBeNull()

    // 刚重排过的记录不会再被 `before` 圈到。
    const again = await requeueFailedLegacyMediaAudit(db, {
      limit: 10,
      before: new Date(Date.now() - 60_000),
    })
    expect(again.requeued).toBe(0)
  })
})

async function countModerationRecords(): Promise<number> {
  const rows = await db
    .select({ id: listingModerationRecords.id })
    .from(listingModerationRecords)
    .where(eq(listingModerationRecords.action, 'LEGACY_MEDIA_AUDIT'))
  return rows.length
}
