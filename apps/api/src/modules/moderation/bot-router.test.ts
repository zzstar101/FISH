import { afterAll, describe, expect, test } from 'bun:test'
import type { AdminModerationQueueItem } from '@fish/contracts/admin/schema'
import { createDb } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { jobs } from '@fish/db/schema/jobs'
import { listings } from '@fish/db/schema/listings'
import { listingModerationRecords, moderationModelReviews } from '@fish/db/schema/moderation'
import { users } from '@fish/db/schema/users'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { eq, inArray, sql } from 'drizzle-orm'
import { createSqlListingStore } from '../listings/store'
import type { MediaStorage } from '../uploads/storage'
import { type BotModerationService, createModerationBotRouter } from './bot-router'

// 与 packages/db 的集成测试同一约定：没有 DATABASE_URL 就明确失败，而不是静默跳过。
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const db = createDb(databaseUrl)
const store = createSqlListingStore(db)

const TOKEN = 'test-bot-token-0123456789abcdef0123456789abcdef'
const storage = {
  publicUrl: (key: string) => `https://cdn.test/${key}`,
} as unknown as MediaStorage

const createdListingIds: string[] = []
const createdUserIds: string[] = []

afterAll(async () => {
  for (const listingId of createdListingIds) {
    // jobs 与 listings 没有外键关系，只能按 payload 清理。
    await db.delete(jobs).where(sql`${jobs.payload}->>'listingId' = ${listingId}`)
  }
  if (createdListingIds.length > 0) {
    await db.delete(listings).where(inArray(listings.id, createdListingIds))
  }
  if (createdUserIds.length > 0) {
    await db
      .delete(listingModerationRecords)
      .where(inArray(listingModerationRecords.sellerId, createdUserIds))
    await db.delete(users).where(inArray(users.id, createdUserIds))
  }
})

async function createUser(nickname: string): Promise<string> {
  const rows = await db.insert(users).values({ nickname }).returning({ id: users.id })
  const row = rows[0]
  if (!row) throw new Error('insert users 未返回行')
  createdUserIds.push(row.id)
  return row.id
}

/** 造一条「腾讯判 REVIEW」的商品：两条图、一条审核记录、一条模型复核。 */
async function createReviewFixture() {
  const sellerId = await createUser('卖家')
  const actorUserId = await createUser('审核员')
  const objectKeys = [
    `listing-review-media/${sellerId}/cover.jpg`,
    `listing-review-media/${sellerId}/back.jpg`,
  ]
  const listingId = newId()
  await store.createListingAtomic({
    id: listingId,
    sellerId,
    title: 'Python 编程基础及应用',
    description: '教育部规划教材，封面有出版社信息',
    priceCents: 1600,
    category: 'BOOKS',
    condition: 'GOOD',
    urgent: false,
    negotiable: false,
    free: false,
    objectKeys,
    duplicateWindowStart: new Date(Date.now() - 5_000),
    moderationStatus: 'REVIEW',
    moderation: {
      decision: 'REVIEW',
      matchedRules: ['POLITY'],
      matchedTermsMasked: ['教*部'],
      ruleVersion: 'biz-228',
      provider: 'TENCENT_TMS',
      providerRequestId: 'req-1',
      suggestion: 'Review',
      label: 'Polity',
      subLabel: 'NationalInstitution',
      score: 93,
    },
  })
  createdListingIds.push(listingId)

  const records = await db
    .select({ id: listingModerationRecords.id, createdAt: listingModerationRecords.createdAt })
    .from(listingModerationRecords)
    .where(eq(listingModerationRecords.listingId, listingId))
  const record = records[0]
  if (!record) throw new Error('未写入审核记录')

  await db.insert(moderationModelReviews).values({
    listingId,
    moderationRecordId: record.id,
    model: 'DeepSeek-V4.1-Flash',
    promptVersion: '2026-11-21-v2',
    inputDigest: 'd'.repeat(64),
    decision: 'PASS',
    category: null,
    reason: '教材封面的「教育部」是出版信息。',
    evidence: ['封面为人民邮电出版社教材'],
    confidence: 0.9,
    latencyMs: 1234,
    outcome: 'SHADOW',
  })

  const listingRows = await db
    .select({ createdAt: listings.createdAt })
    .from(listings)
    .where(eq(listings.id, listingId))
  const listingCreatedAt = listingRows[0]?.createdAt ?? new Date()

  const publicListingId = encodePublicId(PUBLIC_ID_PREFIX.listing, listingId)
  const item: AdminModerationQueueItem = {
    record: {
      id: encodePublicId(PUBLIC_ID_PREFIX.moderationRecord, record.id),
      listingId: publicListingId,
      sellerId: encodePublicId(PUBLIC_ID_PREFIX.user, sellerId),
      action: 'CREATE',
      titleSnapshot: 'Python 编程基础及应用',
      descriptionSnapshot: '教育部规划教材，封面有出版社信息',
      decision: 'REVIEW',
      matchedRules: ['POLITY'],
      matchedTermsMasked: ['教*部'],
      ruleVersion: 'biz-228',
      provider: 'TENCENT_TMS',
      providerRequestId: 'req-1',
      suggestion: 'Review',
      label: 'Polity',
      subLabel: 'NationalInstitution',
      score: 93,
      createdAt: record.createdAt.toISOString(),
    },
    listing: {
      id: publicListingId,
      title: 'Python 编程基础及应用',
      description: '教育部规划教材，封面有出版社信息',
      status: 'OFFLINE',
      moderationStatus: 'REVIEW',
      moderationReason: null,
      createdAt: listingCreatedAt.toISOString(),
    },
    seller: {
      id: encodePublicId(PUBLIC_ID_PREFIX.user, sellerId),
      nickname: '卖家',
    },
  }

  return { sellerId, actorUserId, listingId, recordId: record.id, item }
}

function routerWith(service: BotModerationService, actorUserId: string) {
  return createModerationBotRouter({ service, db, storage, token: TOKEN, actorUserId })
}

function fakeService(items: AdminModerationQueueItem[]) {
  const decisions: Parameters<BotModerationService['decideModeration']>[0][] = []
  const service: BotModerationService = {
    async listModerationQueue() {
      return { items }
    },
    async decideModeration(input) {
      decisions.push(input)
    },
  }
  return { service, decisions }
}

describe('飞书审核台内部接口', () => {
  test('没有 token 或 token 不对：401，不泄漏任何待审内容', async () => {
    const { service } = fakeService([])
    const router = routerWith(service, 'actor')
    const cases: Record<string, string>[] = [{}, { authorization: 'Bearer wrong' }]
    for (const headers of cases) {
      const response = await router.request('/pending', { headers })
      expect(response.status).toBe(401)
    }
  })

  test('待审列表带上价格、类目、前几张签名图与模型结论', async () => {
    const fixture = await createReviewFixture()
    const { service } = fakeService([fixture.item])

    const response = await routerWith(service, fixture.actorUserId).request('/pending', {
      headers: { authorization: `Bearer ${TOKEN}` },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { items: Record<string, unknown>[] }
    expect(body.items).toHaveLength(1)
    expect(body.items[0]).toMatchObject({
      recordId: fixture.item.record.id,
      listingId: fixture.item.listing.id,
      priceCents: 1600,
      category: 'BOOKS',
      sellerNickname: '卖家',
      imageCount: 2,
      label: 'Polity',
      subLabel: 'NationalInstitution',
      score: 93,
    })
    expect(body.items[0]?.images).toEqual([
      { url: expect.stringContaining('listing-review-media/'), position: 1 },
      { url: expect.stringContaining('listing-review-media/'), position: 2 },
    ])
    expect(body.items[0]?.modelReview).toMatchObject({
      decision: 'PASS',
      outcome: 'SHADOW',
      reason: '教材封面的「教育部」是出版信息。',
    })
  })

  test('通过/拒绝：解码记录 ID、落到 Owner 的 actor、默认理由，并把冲突原样报回', async () => {
    const fixture = await createReviewFixture()
    const { service, decisions } = fakeService([])
    const router = routerWith(service, fixture.actorUserId)
    const path = `/${fixture.item.record.id}/decision`

    const missingKey = await router.request(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'ALLOW' }),
    })
    expect(missingKey.status).toBe(422)

    const ok = await router.request(path, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'Idempotency-Key': 'lark-card-1',
      },
      body: JSON.stringify({ decision: 'BLOCK' }),
    })
    expect(ok.status).toBe(200)
    expect(decisions).toEqual([
      {
        recordId: fixture.recordId,
        actorUserId: fixture.actorUserId,
        decision: 'BLOCK',
        reason: '飞书审核台人工复核',
        requestId: 'lark-card-1',
      },
    ])

    // 记录已被别处处理（admin 域抛 AdminError 409）：机器人要能区分「已处理」与「服务器炸了」。
    const conflictService: BotModerationService = {
      async listModerationQueue() {
        return { items: [] }
      },
      async decideModeration() {
        throw Object.assign(new Error('审核记录已处理或已过期'), {
          code: 'MODERATION_CONFLICT',
          status: 409,
        })
      },
    }
    const conflict = await routerWith(conflictService, fixture.actorUserId).request(path, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'Idempotency-Key': 'lark-card-2',
      },
      body: JSON.stringify({ decision: 'ALLOW' }),
    })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ error: 'MODERATION_CONFLICT' })
  })
})
