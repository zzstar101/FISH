import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb, type Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { jsonParam } from '@fish/db/json'
import { listings } from '@fish/db/schema/listings'
import { recommendationEvents } from '@fish/db/schema/recommendation-events'
import { recommendationRequestItems } from '@fish/db/schema/recommendation-request-items'
import { recommendationRequests } from '@fish/db/schema/recommendation-requests'
import { users } from '@fish/db/schema/users'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import type { ModerationStore } from '../moderation/store'
import { createSqlAdminStore } from './store'

// #323 R6：`getRecommendationMetrics` 的 SQL 口径（请求轴切窗、归因事件分桶、卖家集中度、
// 陈旧曝光）只能在真库上验证——纯函数测试覆盖不了 `NOT EXISTS` / `count(DISTINCT ...)` /
// `WITH attributed` 这些写法。自建 scratch 库，不碰开发库，也不受 seed 数据影响。
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const scratchDatabase = `fish_admin_metrics_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()
const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../../../packages/db/src/migrations', import.meta.url),
)

const admin = createDb(databaseUrl)
let db: Db
let store: ReturnType<typeof createSqlAdminStore>

const SINCE = new Date('2026-01-10T00:00:00Z')
const UNTIL = new Date('2026-01-11T00:00:00Z')
const RANKED_VERSION = 'rec-v1-rule+interest-v1+recall-v1+rank-v1'
const DEGRADED_VERSION = 'rec-v1-none'

const listingIds: Record<'l1' | 'l2' | 'l3', string> = { l1: '', l2: '', l3: '' }
const requestIds: Record<
  'ranked' | 'degraded' | 'empty' | 'repeat' | 'before' | 'atUntil',
  string
> = { ranked: '', degraded: '', empty: '', repeat: '', before: '', atUntil: '' }
let userAId = ''
let userBId = ''
let anonymousId = ''

beforeAll(async () => {
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  db = createDb(scratchUrl)
  await migrate(db, { migrationsFolder })
  store = createSqlAdminStore(db, {} as ModerationStore)

  const sellers = await db
    .insert(users)
    .values([
      {
        studentNo: `admin-metrics-a-${Date.now()}`,
        passwordHash: 'test-not-a-real-hash',
        nickname: '卖家甲',
      },
      {
        studentNo: `admin-metrics-b-${Date.now()}`,
        passwordHash: 'test-not-a-real-hash',
        nickname: '卖家乙',
      },
    ])
    .returning({ id: users.id })
  const sellerA = sellers[0]
  const sellerB = sellers[1]
  if (!sellerA || !sellerB) throw new Error('insert users 未返回两行')
  userAId = sellerA.id
  userBId = sellerB.id
  anonymousId = newId()

  // L1 卖家甲在售、L2 卖家乙在售、L3 卖家乙已成交（陈旧曝光的来源）。
  for (const [key, sellerId, status] of [
    ['l1', userAId, 'ACTIVE'],
    ['l2', userBId, 'ACTIVE'],
    ['l3', userBId, 'SOLD'],
  ] as const) {
    const id = newId()
    listingIds[key] = id
    await db.insert(listings).values({
      id,
      listingNo: await reserveTestListingNo(db, id),
      sellerId,
      title: `指标商品 ${key}`,
      description: '指标测试',
      priceCents: 1000,
      category: 'DIGITAL',
      condition: 'GOOD',
      status,
    })
  }

  const insertedRequests = await db
    .insert(recommendationRequests)
    .values([
      // 窗口内：排序请求（有 2 行快照）
      {
        id: newId(),
        userId: userAId,
        strategyVersion: RANKED_VERSION,
        requestedAt: new Date('2026-01-10T10:00:00Z'),
      },
      // 窗口内：降级透传（按 R1 口径没有快照）
      {
        id: newId(),
        anonymousSessionId: anonymousId,
        strategyVersion: DEGRADED_VERSION,
        requestedAt: new Date('2026-01-10T11:00:00Z'),
      },
      // 窗口内：排序请求但一行快照都没有（空召回）
      {
        id: newId(),
        userId: userBId,
        strategyVersion: RANKED_VERSION,
        requestedAt: new Date('2026-01-10T12:00:00Z'),
      },
      // 窗口内：同一身份再次看到 L1，用来验证 (身份, 商品) 去重
      {
        id: newId(),
        userId: userAId,
        strategyVersion: RANKED_VERSION,
        requestedAt: new Date('2026-01-10T13:00:00Z'),
      },
      // 左边界之外（早 1ms）：整条请求连同它的快照都不进指标
      {
        id: newId(),
        userId: userAId,
        strategyVersion: RANKED_VERSION,
        requestedAt: new Date(SINCE.getTime() - 1),
      },
      // 右边界（等于 until）：左闭右开，同样不计入
      {
        id: newId(),
        userId: userAId,
        strategyVersion: RANKED_VERSION,
        requestedAt: UNTIL,
      },
    ])
    .returning({ id: recommendationRequests.id, requestedAt: recommendationRequests.requestedAt })
  const byTime = new Map(insertedRequests.map((row) => [row.requestedAt.toISOString(), row.id]))
  requestIds.ranked = byTime.get('2026-01-10T10:00:00.000Z') ?? ''
  requestIds.degraded = byTime.get('2026-01-10T11:00:00.000Z') ?? ''
  requestIds.empty = byTime.get('2026-01-10T12:00:00.000Z') ?? ''
  requestIds.repeat = byTime.get('2026-01-10T13:00:00.000Z') ?? ''
  requestIds.before = byTime.get(new Date(SINCE.getTime() - 1).toISOString()) ?? ''
  requestIds.atUntil = byTime.get(UNTIL.toISOString()) ?? ''
  for (const [key, id] of Object.entries(requestIds)) {
    if (!id) throw new Error(`缺少请求 ${key}`)
  }

  const breakdown = jsonParam({
    semantic: { normalized: 0.5, weight: 0.35, contribution: 0.175 },
    missing: ['wish'],
  })
  await db.insert(recommendationRequestItems).values([
    {
      requestId: requestIds.ranked,
      position: 0,
      listingId: listingIds.l1,
      primarySource: 'semantic',
      sources: ['semantic', 'fresh'],
      rankScore: 0.5,
      rankBreakdown: breakdown,
    },
    {
      requestId: requestIds.ranked,
      position: 1,
      listingId: listingIds.l2,
      primarySource: 'fresh',
      sources: ['fresh'],
      rankScore: 0.4,
      rankBreakdown: breakdown,
    },
    {
      requestId: requestIds.repeat,
      position: 0,
      listingId: listingIds.l1,
      primarySource: 'popular',
      sources: ['popular'],
      rankScore: 0.3,
      rankBreakdown: breakdown,
    },
    // 边界外的请求也有快照行，验证快照统计同样按请求轴切窗（而不是"扫全表"）
    {
      requestId: requestIds.before,
      position: 0,
      listingId: listingIds.l2,
      primarySource: 'fresh',
      sources: ['fresh'],
      rankScore: 0.2,
      rankBreakdown: breakdown,
    },
    {
      requestId: requestIds.atUntil,
      position: 0,
      listingId: listingIds.l2,
      primarySource: 'fresh',
      sources: ['fresh'],
      rankScore: 0.2,
      rankBreakdown: breakdown,
    },
  ])

  await db.insert(recommendationEvents).values([
    // 归因曝光 3 条：L1（卖家甲）、L2/L3（卖家乙，其中 L3 已成交）
    {
      eventId: newId(),
      userId: userAId,
      listingId: listingIds.l1,
      eventType: 'IMPRESSION',
      requestId: requestIds.ranked,
      position: 0,
      occurredAt: new Date('2026-01-10T10:01:00Z'),
    },
    {
      eventId: newId(),
      userId: userAId,
      listingId: listingIds.l2,
      eventType: 'IMPRESSION',
      requestId: requestIds.ranked,
      position: 1,
      occurredAt: new Date('2026-01-10T10:01:00Z'),
    },
    {
      eventId: newId(),
      userId: userAId,
      listingId: listingIds.l3,
      eventType: 'IMPRESSION',
      requestId: requestIds.ranked,
      position: 2,
      occurredAt: new Date('2026-01-10T10:01:00Z'),
    },
    // 无归因的详情页（不是曝光，不参与卖家集中度；也不进事件分桶）
    {
      eventId: newId(),
      userId: userAId,
      listingId: listingIds.l1,
      eventType: 'DETAIL_VIEW',
      requestId: null,
      position: null,
      occurredAt: new Date('2026-01-10T10:02:00Z'),
    },
    // 有归因的详情页
    {
      eventId: newId(),
      userId: userAId,
      listingId: listingIds.l2,
      eventType: 'DETAIL_VIEW',
      requestId: requestIds.ranked,
      position: 1,
      occurredAt: new Date('2026-01-10T10:03:00Z'),
    },
    // 窗口外（早于 since）的归因曝光：验证事件轴切窗
    {
      eventId: newId(),
      userId: userAId,
      listingId: listingIds.l2,
      eventType: 'IMPRESSION',
      requestId: requestIds.before,
      position: 0,
      occurredAt: new Date(SINCE.getTime() - 1),
    },
    // 右边界事件（等于 until）：左闭右开，不计入
    {
      eventId: newId(),
      userId: userAId,
      listingId: listingIds.l1,
      eventType: 'IMPRESSION',
      requestId: requestIds.atUntil,
      position: 0,
      occurredAt: UNTIL,
    },
  ])
})

afterAll(async () => {
  await db.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

describe('getRecommendationMetrics（#323 R6 SQL 口径）', () => {
  test('请求轴左闭右开切窗：降级 / 排序 / 空快照三类分开计数', async () => {
    const row = await store.getRecommendationMetrics({ since: SINCE, until: UNTIL })

    // 窗口内 4 条（ranked / degraded / empty / repeat），边界上的两条都不算。
    expect(row.feedRequests).toBe(4)
    expect(row.degradedFeedRequests).toBe(1)
    expect(row.rankedFeedRequests).toBe(3)
    // 只有 `empty` 那条排序请求一行快照都没有。
    expect(row.emptyRankedFeedRequests).toBe(1)
  })

  test('快照按请求轴切窗，并按 (身份, 商品) 去重', async () => {
    const row = await store.getRecommendationMetrics({ since: SINCE, until: UNTIL })

    // ranked 2 行 + repeat 1 行；边界外两条请求各有 1 行，必须被切掉。
    expect(row.snapshotItems).toBe(3)
    // (userA, L1) 出现两次，去重后 2 对 ⇒ 重复曝光率 = 1/3。
    expect(row.snapshotDistinctPairs).toBe(2)
  })

  test('事件分桶只看窗口内有归因的事件', async () => {
    const row = await store.getRecommendationMetrics({ since: SINCE, until: UNTIL })

    expect(row.attributedEventCounts.get('IMPRESSION')).toBe(3)
    expect(row.attributedEventCounts.get('DETAIL_VIEW')).toBe(1)
    // 没有归因的详情页不进任何桶；窗口外与右边界上的曝光也不进。
    expect([...row.attributedEventCounts.keys()].sort()).toEqual(['DETAIL_VIEW', 'IMPRESSION'])
  })

  test('卖家集中度只看归因曝光，陈旧曝光按商品当前状态判定', async () => {
    const row = await store.getRecommendationMetrics({ since: SINCE, until: UNTIL })

    expect(row.attributedImpressions).toBe(3)
    // 卖家乙 2 次（L2 + L3）、卖家甲 1 次。
    expect(row.topSellerExposures).toBe(2)
    expect(row.top10SellerExposures).toBe(3)
    // L3 现在是 SOLD，仍被曝光过 ⇒ 陈旧曝光 1 次。
    expect(row.staleListingExposures).toBe(1)
  })

  test('空窗口不抛错：计数 0、事件表为空', async () => {
    const row = await store.getRecommendationMetrics({
      since: new Date('2025-01-01T00:00:00Z'),
      until: new Date('2025-01-02T00:00:00Z'),
    })

    expect(row.feedRequests).toBe(0)
    expect(row.snapshotItems).toBe(0)
    expect(row.attributedImpressions).toBe(0)
    expect(row.topSellerExposures).toBe(0)
    expect(row.top10SellerExposures).toBe(0)
    expect(row.staleListingExposures).toBe(0)
    expect(row.attributedEventCounts.size).toBe(0)
  })
})
