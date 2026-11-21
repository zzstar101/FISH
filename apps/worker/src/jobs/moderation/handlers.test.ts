import { afterAll, describe, expect, test } from 'bun:test'
import { createDb } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { listingMediaObjects } from '@fish/db/schema/listing-media'
import { listingNumbers } from '@fish/db/schema/listing-numbers'
import { listingImages, listings } from '@fish/db/schema/listings'
import { listingModerationRecords, moderationModelReviews } from '@fish/db/schema/moderation'
import { notifications } from '@fish/db/schema/notifications'
import { users } from '@fish/db/schema/users'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { eq, inArray, sql } from 'drizzle-orm'
import type { WorkerMediaStorage } from '../../media-storage'
import { toRows } from '../queue'
import {
  AUTO_REJECT_REASON,
  createModerationJobHandlers,
  decideOutcome,
  type ModerationOutcome,
} from './handlers'
import type { ModerationModelClient, ModerationModelResponse } from './model-client'
import type { ModerationReview } from './review'

// 与 #322 文本侧 / #324 视觉侧同一约定：没有 DATABASE_URL 就明确失败，而不是静默跳过。
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const db = createDb(databaseUrl)
const createdUserIds: string[] = []
const createdListingIds: string[] = []

afterAll(async () => {
  if (createdListingIds.length > 0) {
    // `listing_moderation_records.listing_id` 是 SET NULL，不会随商品删除消失，得显式清。
    await db
      .delete(listingModerationRecords)
      .where(inArray(listingModerationRecords.listingId, createdListingIds))
    await db.delete(listings).where(inArray(listings.id, createdListingIds))
    await db.delete(listingNumbers).where(inArray(listingNumbers.listingId, createdListingIds))
    await db.execute(sql`
      DELETE FROM jobs
      WHERE payload->>'listingId' IN (${sql.join(
        createdListingIds.map((id) => sql`${id}`),
        sql`, `,
      )})
    `)
  }
  if (createdUserIds.length > 0) {
    await db.delete(notifications).where(inArray(notifications.userId, createdUserIds))
    await db.delete(listingMediaObjects).where(inArray(listingMediaObjects.userId, createdUserIds))
    await db.delete(users).where(inArray(users.id, createdUserIds))
  }
  await db.$client.close()
})

async function createUser(): Promise<string> {
  const rows = await db.insert(users).values({ nickname: '模型复核 handler 测试' }).returning({
    id: users.id,
  })
  const row = rows[0]
  if (!row) throw new Error('insert users 未返回行')
  createdUserIds.push(row.id)
  return row.id
}

type Fixture = {
  listingId: string
  sellerId: string
}

/** 造一条「腾讯判 REVIEW」的商品：状态、审核记录、一张图片都按真实链路的形状写。 */
async function createReviewListing(
  overrides: { label?: string; moderationStatus?: 'REVIEW' | 'APPROVED' | 'BLOCKED' } = {},
): Promise<Fixture> {
  const sellerId = await createUser()
  const listingId = newId()
  createdListingIds.push(listingId)
  const moderationStatus = overrides.moderationStatus ?? 'REVIEW'
  await db.insert(listings).values({
    id: listingId,
    listingNo: await reserveTestListingNo(db, listingId),
    sellerId,
    title: 'Python 编程基础及应用',
    description: '教育部大学计算机课程改革项目规划教材，九成新，附光盘',
    priceCents: 2500,
    category: 'BOOKS',
    condition: 'GOOD',
    status: 'OFFLINE',
    moderationStatus,
    moderationReason: moderationStatus === 'REVIEW' ? '商品需要人工审核' : null,
  })
  // REVIEW 图在真实链路里固化到私有前缀（`listing-review-media/…`），台账行的 final_key 就是它；
  // 模型放行要按这个键结算结论，所以 fixture 必须造出这一行。
  const reviewKey = `listing-review-media/${sellerId}/cover.jpg`
  await db.insert(listingMediaObjects).values({
    userId: sellerId,
    stagingKey: `listing-media/${sellerId}/cover.jpg`,
    finalKey: reviewKey,
    contentDigest: 'a'.repeat(64),
    moderationDecision: 'REVIEW',
    provider: 'TENCENT_IMS',
    providerRequestId: 'req-img-1',
  })
  await db.insert(listingImages).values({
    listingId,
    objectKey: reviewKey,
    sortOrder: 0,
  })
  await db.insert(listingModerationRecords).values({
    listingId,
    sellerId,
    action: 'LISTING_SUBMIT',
    titleSnapshot: 'Python 编程基础及应用',
    descriptionSnapshot: '教育部大学计算机课程改革项目规划教材，九成新，附光盘',
    decision: moderationStatus === 'REVIEW' ? 'REVIEW' : 'BLOCK',
    matchedRules: [],
    matchedTermsMasked: [],
    ruleVersion: 'TencentCloudDefault',
    provider: 'TENCENT_TMS',
    providerRequestId: 'req-1',
    suggestion: moderationStatus === 'REVIEW' ? 'Review' : 'Block',
    label: overrides.label ?? 'Polity',
    subLabel: 'NationalInstitution',
    score: 92,
  })
  return { listingId, sellerId }
}

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])

function fakeStorage(): WorkerMediaStorage {
  return {
    async readBytes() {
      return JPEG_BYTES
    },
    async deleteObject() {},
  }
}

function fakeClient(content: string): ModerationModelClient & { calls: number } {
  const state = {
    calls: 0,
    model: 'test-model',
    async review(): Promise<ModerationModelResponse> {
      state.calls += 1
      return { content, promptTokens: 1200, completionTokens: 90 }
    },
  }
  return state
}

const PASS_JSON = JSON.stringify({
  decision: 'PASS',
  category: null,
  reason: '教材封面的「教育部」是出版信息，不是涉政内容。',
  evidence: ['封面为人民邮电出版社教材'],
  confidence: 0.9,
})
const BLOCK_JSON = JSON.stringify({
  decision: 'BLOCK',
  category: 'AD',
  reason: '描述里留了微信，属于站外交易引流。',
  evidence: ['描述含微信号'],
  confidence: 0.8,
})

function handlersWith(
  client: ModerationModelClient | null,
  mode: 'shadow' | 'enforce' | 'off' = 'enforce',
) {
  return createModerationJobHandlers(db, {
    env:
      mode === 'off'
        ? { mode: 'off' }
        : { mode, baseUrl: 'https://example.test', apiKey: 'k', model: 'm' },
    storage: fakeStorage(),
    client,
  })
}

async function listingState(listingId: string) {
  const rows = await db
    .select({
      status: listings.status,
      moderationStatus: listings.moderationStatus,
      moderationReason: listings.moderationReason,
    })
    .from(listings)
    .where(eq(listings.id, listingId))
    .limit(1)
  const row = rows[0]
  if (!row) throw new Error('商品不存在')
  return row
}

async function reviewRows(listingId: string) {
  return db
    .select({
      decision: moderationModelReviews.decision,
      outcome: moderationModelReviews.outcome,
      reason: moderationModelReviews.reason,
      promptTokens: moderationModelReviews.promptTokens,
    })
    .from(moderationModelReviews)
    .where(eq(moderationModelReviews.listingId, listingId))
}

async function mediaSettlement(listingId: string) {
  return db
    .select({ settledDecision: listingMediaObjects.settledDecision })
    .from(listingMediaObjects)
    .innerJoin(listingImages, eq(listingImages.objectKey, listingMediaObjects.finalKey))
    .where(eq(listingImages.listingId, listingId))
}

async function notificationOutcomes(listingId: string): Promise<string[]> {
  const rows = await db.execute(sql`
    SELECT payload->>'outcome' AS outcome FROM notifications
    WHERE type = 'MODERATION' AND payload->>'listingId' = ${listingId}
    ORDER BY created_at
  `)
  return toRows(rows).map((row) => String(row.outcome))
}

async function jobTypes(listingId: string): Promise<string[]> {
  const rows = await db.execute(sql`
    SELECT type FROM jobs WHERE payload->>'listingId' = ${listingId} ORDER BY type
  `)
  return toRows(rows).map((row) => String(row.type))
}

describe('decideOutcome（纯函数）', () => {
  test('影子期什么结论都不生效', () => {
    for (const decision of ['PASS', 'BLOCK', 'UNSURE'] as const) {
      expect(
        decideOutcome({
          mode: 'shadow',
          review: { decision, category: null, reason: 'r', evidence: [], confidence: null },
        }),
      ).toBe<ModerationOutcome>('SHADOW')
    }
  })

  test('enforce：PASS 自动放行、BLOCK 自动拒绝、UNSURE / ERROR 转人工', () => {
    const base: Omit<ModerationReview, 'decision'> = {
      category: null,
      reason: 'r',
      evidence: [],
      confidence: null,
    }
    expect(decideOutcome({ mode: 'enforce', review: { ...base, decision: 'PASS' } })).toBe(
      'AUTO_PASSED',
    )
    expect(decideOutcome({ mode: 'enforce', review: { ...base, decision: 'BLOCK' } })).toBe(
      'AUTO_REJECTED',
    )
    expect(decideOutcome({ mode: 'enforce', review: { ...base, decision: 'UNSURE' } })).toBe(
      'PENDING',
    )
    expect(decideOutcome({ mode: 'enforce', review: { ...base, decision: 'ERROR' } })).toBe(
      'PENDING',
    )
  })
})

describe('LISTING_MODERATION handler（真实 DB）', () => {
  test('模型 PASS → 商品上架，并补投索引 job', async () => {
    const { listingId } = await createReviewListing()
    const client = fakeClient(PASS_JSON)
    const handlers = handlersWith(client)

    const result = await handlers.LISTING_MODERATION({ listingId })

    expect(result).toMatchObject({ status: 'recorded', outcome: 'AUTO_PASSED', images: 1 })
    expect(client.calls).toBe(1)
    expect(await listingState(listingId)).toEqual({
      status: 'ACTIVE',
      moderationStatus: 'APPROVED',
      moderationReason: null,
    })
    const rows = await reviewRows(listingId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ decision: 'PASS', outcome: 'AUTO_PASSED', promptTokens: 1200 })
    // 审核中商品从没投过索引 job，放行时要补上（否则商品上架了但永远搜不到）。
    expect(await jobTypes(listingId)).toEqual(['EMBED_LISTING', 'MATCH_LISTING'])
    // 图片结论必须一起翻成 ALLOW：否则卖家下一次不改图的编辑会读到机器 REVIEW，把商品压回队列。
    expect(await mediaSettlement(listingId)).toEqual([{ settledDecision: 'ALLOW' }])
    expect(await notificationOutcomes(listingId)).toEqual(['APPROVED'])
  })

  test('模型 BLOCK → 商品下架 + 固定话术（不含模型理由）', async () => {
    const { listingId } = await createReviewListing()
    const handlers = handlersWith(fakeClient(BLOCK_JSON))

    const result = await handlers.LISTING_MODERATION({ listingId })

    expect(result).toMatchObject({ status: 'recorded', outcome: 'AUTO_REJECTED' })
    expect(await listingState(listingId)).toEqual({
      status: 'OFFLINE',
      moderationStatus: 'BLOCKED',
      moderationReason: AUTO_REJECT_REASON,
    })
    expect(await jobTypes(listingId)).toEqual([])
    const rows = await reviewRows(listingId)
    // 模型理由进后台记录，但不进 moderation_reason。
    expect(rows[0]?.reason).toContain('微信')
    // 模型拒绝可以被申诉推翻：图片保持未结算的原始 REVIEW，不钉成 BLOCK。
    expect(await mediaSettlement(listingId)).toEqual([{ settledDecision: null }])
    expect(await notificationOutcomes(listingId)).toEqual(['REJECTED'])
  })

  test('影子模式：结论落库，状态不动', async () => {
    const { listingId } = await createReviewListing()
    const handlers = handlersWith(fakeClient(PASS_JSON), 'shadow')

    const result = await handlers.LISTING_MODERATION({ listingId })

    expect(result).toMatchObject({ status: 'recorded', outcome: 'SHADOW' })
    expect((await listingState(listingId)).moderationStatus).toBe('REVIEW')
    expect((await reviewRows(listingId))[0]?.outcome).toBe('SHADOW')
  })

  test('严重标签不调模型：色情 Review 也必须人工', async () => {
    const { listingId } = await createReviewListing({ label: 'Porn' })
    const client = fakeClient(PASS_JSON)
    const handlers = handlersWith(client)

    const result = await handlers.LISTING_MODERATION({ listingId })

    expect(result).toMatchObject({ status: 'skipped', reason: 'severe-label' })
    expect(client.calls).toBe(0)
    expect(await reviewRows(listingId)).toHaveLength(0)
    expect((await listingState(listingId)).moderationStatus).toBe('REVIEW')
  })

  test('模型出错 → ERROR + 转人工，绝不放行', async () => {
    const { listingId } = await createReviewListing()
    const handlers = createModerationJobHandlers(db, {
      env: { mode: 'enforce', baseUrl: 'https://example.test', apiKey: 'k', model: 'm' },
      storage: fakeStorage(),
      client: {
        model: 'test-model',
        async review() {
          throw new Error('socket hang up')
        },
      },
    })

    const result = await handlers.LISTING_MODERATION({ listingId })

    expect(result).toMatchObject({ status: 'recorded', outcome: 'PENDING' })
    expect((await listingState(listingId)).moderationStatus).toBe('REVIEW')
    const rows = await reviewRows(listingId)
    expect(rows[0]).toMatchObject({ decision: 'ERROR', outcome: 'PENDING' })
  })

  test('不是 REVIEW 的商品直接跳过（不重复判、不改状态）', async () => {
    const { listingId } = await createReviewListing({ moderationStatus: 'APPROVED' })
    const handlers = handlersWith(fakeClient(PASS_JSON))

    const result = await handlers.LISTING_MODERATION({ listingId })

    expect(result).toMatchObject({ status: 'skipped', reason: 'not-review' })
    expect(await reviewRows(listingId)).toHaveLength(0)
  })

  test('同一条商品跑了两次：第二次撞唯一索引，不改状态', async () => {
    const { listingId } = await createReviewListing()
    const handlers = handlersWith(fakeClient(BLOCK_JSON))

    expect(await handlers.LISTING_MODERATION({ listingId })).toMatchObject({
      status: 'recorded',
      outcome: 'AUTO_REJECTED',
    })
    // 人工把它改回 REVIEW 后重试：结论已有，不再动。
    await db
      .update(listings)
      .set({ moderationStatus: 'REVIEW', status: 'OFFLINE', moderationReason: '待审核' })
      .where(eq(listings.id, listingId))
    expect(await handlers.LISTING_MODERATION({ listingId })).toMatchObject({ status: 'duplicate' })
    expect((await listingState(listingId)).moderationStatus).toBe('REVIEW')
    expect(await reviewRows(listingId)).toHaveLength(1)
  })

  test('开关关掉时只跳过，不落记录', async () => {
    const { listingId } = await createReviewListing()
    const handlers = handlersWith(fakeClient(PASS_JSON), 'off')

    expect(await handlers.LISTING_MODERATION({ listingId })).toMatchObject({
      status: 'skipped',
      reason: 'model-review-off',
    })
    expect(await reviewRows(listingId)).toHaveLength(0)
  })
})
