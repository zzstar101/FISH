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
// 生命周期夹具（#323 M8）单独放第二个窗口：`getRecommendationMetrics` 的所有聚合都按
// `occurred_at` / `created_at` / `requested_at` 切窗，换个窗口就不会动到上面那批断言。
const SINCE2 = new Date('2026-01-20T00:00:00Z')
const UNTIL2 = new Date('2026-01-21T00:00:00Z')
const LIFECYCLE_CREATED_AT = new Date('2026-01-20T08:00:00Z')
// 零"成交前曝光"样本（#323 必修项）故意创建在窗口**之外**：它只进 `exposuresBeforeSale`，
// 不该动"窗口内新建"的曝光/意向两项。
const ZERO_EXPOSURE_CREATED_AT = new Date('2025-12-01T00:00:00Z')
const RANKED_VERSION = 'rec-v1-rule+interest-v1+recall-v1+rank-v1'
const DEGRADED_VERSION = 'rec-v1-none'

const listingIds: Record<'l1' | 'l2' | 'l3', string> = { l1: '', l2: '', l3: '' }
const lifecycleListingIds: Record<'n1' | 'n2' | 'n3' | 'n4' | 'n5', string> = {
  n1: '',
  n2: '',
  n3: '',
  n4: '',
  n5: '',
}
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

  // ---------------------------------------------------------------------------
  // 生命周期夹具（#323 M8）：窗口 [SINCE2, UNTIL2)
  //
  // 三个**窗口内创建**的新商品（08:00）：
  //   n1 首次曝光 10:00（+2h）、首次意向 FAVORITE 11:30（+3.5h）、12:30 再曝光、13:00 成交
  //   n2 首次曝光 11:00（+3h）、11:15 有一条 grade 1 的 DETAIL_VIEW、首次意向 CHAT_START 12:00（+4h）
  //   n3 首次曝光 12:00（+4h）、09:30 有一条**无归因** FAVORITE（不算意向）
  // 外加窗口外创建的老商品 l3：14:00 曝光、15:00 成交（只进 exposuresBeforeSale）。
  // 同一商品在同一请求下只能有一条曝光（库级部分唯一索引），所以第二次曝光换一个请求。
  //
  // 另有两处是**回归钉子**（对抗性审查发现原夹具钉不住这两条 SQL 判据）：
  //   - n1 成交（13:00）**之后**的 14:00 还有一条归因曝光 ⇒ 若 `AND a.occurred_at < p.sold_at`
  //     被删掉，`exposuresBeforeSale` 会多算这一条，p90 从 2 变成 3；
  //   - n2 在首次 grade ≥ 2 意向（CHAT_START 12:00）**之前** 11:15 有一条 grade 1 的 DETAIL_VIEW
  //     ⇒ 若意向阈值从 `grade >= 2` 放宽成 `>= 1`，`firstPublishToFirstIntentHours` 的 median
  //     从 3.5 变成 3.25（p90 从 4 变成 3.5）。
  // ---------------------------------------------------------------------------
  for (const [key, sellerId, status] of [
    ['n1', userAId, 'SOLD'],
    ['n2', userBId, 'ACTIVE'],
    ['n3', userAId, 'ACTIVE'],
  ] as const) {
    const id = newId()
    lifecycleListingIds[key] = id
    await db.insert(listings).values({
      id,
      listingNo: await reserveTestListingNo(db, id),
      sellerId,
      title: `生命周期商品 ${key}`,
      description: '生命周期测试',
      priceCents: 1000,
      category: 'DIGITAL',
      condition: 'GOOD',
      status,
      createdAt: LIFECYCLE_CREATED_AT,
    })
  }

  // 零"成交前曝光"的成交商品（#323 必修项）：窗口外创建 + 窗口内只有一条带归因 `PURCHASE`，
  // 一条归因 `IMPRESSION` 都没有 ⇒ `exposuresBeforeSale` 必须给它们记 **0**，而不是整条丢掉。
  // 放**两个**样本是为了让 0 真正落到中位数上：`[0,0,1,2]` 的最近秩中位数是 0，只加一个时
  // `[0,1,2]` 的中位数仍是 1，断言的"值"就退化成只钉住 count。
  for (const [key, sellerId] of [
    ['n4', userAId],
    ['n5', userBId],
  ] as const) {
    const id = newId()
    lifecycleListingIds[key] = id
    await db.insert(listings).values({
      id,
      listingNo: await reserveTestListingNo(db, id),
      sellerId,
      title: `零曝光成交商品 ${key}`,
      description: '生命周期零曝光样本',
      priceCents: 1000,
      category: 'DIGITAL',
      condition: 'GOOD',
      status: 'SOLD',
      createdAt: ZERO_EXPOSURE_CREATED_AT,
    })
  }

  const lifecycleRequests = await db
    .insert(recommendationRequests)
    .values([
      {
        id: newId(),
        userId: userAId,
        strategyVersion: RANKED_VERSION,
        requestedAt: new Date('2026-01-20T07:00:00Z'),
      },
      {
        id: newId(),
        userId: userAId,
        strategyVersion: RANKED_VERSION,
        requestedAt: new Date('2026-01-20T12:15:00Z'),
      },
      {
        id: newId(),
        userId: userAId,
        strategyVersion: RANKED_VERSION,
        requestedAt: new Date('2026-01-20T13:50:00Z'),
      },
    ])
    .returning({ id: recommendationRequests.id, requestedAt: recommendationRequests.requestedAt })
  const lifecycleByTime = new Map(
    lifecycleRequests.map((row) => [row.requestedAt.toISOString(), row.id]),
  )
  const w2 = lifecycleByTime.get('2026-01-20T07:00:00.000Z') ?? ''
  const w2b = lifecycleByTime.get('2026-01-20T12:15:00.000Z') ?? ''
  const w2c = lifecycleByTime.get('2026-01-20T13:50:00.000Z') ?? ''
  if (!w2 || !w2b || !w2c) throw new Error('缺少生命周期夹具请求')

  await db.insert(recommendationEvents).values([
    {
      eventId: newId(),
      userId: userAId,
      listingId: lifecycleListingIds.n1,
      eventType: 'IMPRESSION',
      requestId: w2,
      position: 0,
      occurredAt: new Date('2026-01-20T10:00:00Z'),
    },
    {
      eventId: newId(),
      userId: userAId,
      listingId: lifecycleListingIds.n1,
      eventType: 'FAVORITE',
      requestId: w2,
      position: 1,
      occurredAt: new Date('2026-01-20T11:30:00Z'),
    },
    {
      eventId: newId(),
      userId: userAId,
      listingId: lifecycleListingIds.n1,
      eventType: 'IMPRESSION',
      requestId: w2b,
      position: 0,
      occurredAt: new Date('2026-01-20T12:30:00Z'),
    },
    {
      eventId: newId(),
      userId: userAId,
      listingId: lifecycleListingIds.n1,
      eventType: 'PURCHASE',
      requestId: w2b,
      position: null,
      occurredAt: new Date('2026-01-20T13:00:00Z'),
    },
    {
      eventId: newId(),
      userId: userAId,
      listingId: lifecycleListingIds.n2,
      eventType: 'IMPRESSION',
      requestId: w2,
      position: 1,
      occurredAt: new Date('2026-01-20T11:00:00Z'),
    },
    {
      eventId: newId(),
      userId: userAId,
      listingId: lifecycleListingIds.n2,
      eventType: 'CHAT_START',
      requestId: w2,
      position: 1,
      occurredAt: new Date('2026-01-20T12:00:00Z'),
    },
    {
      eventId: newId(),
      userId: userAId,
      listingId: lifecycleListingIds.n3,
      eventType: 'IMPRESSION',
      requestId: w2,
      position: 2,
      occurredAt: new Date('2026-01-20T12:00:00Z'),
    },
    // 无归因的意向事件：不参与任何生命周期统计（若被算进来，n3 的首次意向会变成 1.5h）。
    {
      eventId: newId(),
      userId: userAId,
      listingId: lifecycleListingIds.n3,
      eventType: 'FAVORITE',
      requestId: null,
      position: null,
      occurredAt: new Date('2026-01-20T09:30:00Z'),
    },
    // 窗口外创建的老商品 l3：成交前的曝光只有 14:00 这一条。
    {
      eventId: newId(),
      userId: userAId,
      listingId: listingIds.l3,
      eventType: 'IMPRESSION',
      requestId: w2b,
      position: 1,
      occurredAt: new Date('2026-01-20T14:00:00Z'),
    },
    {
      eventId: newId(),
      userId: userAId,
      listingId: listingIds.l3,
      eventType: 'PURCHASE',
      requestId: w2b,
      position: null,
      occurredAt: new Date('2026-01-20T15:00:00Z'),
    },
    // 回归钉子 1：n1 在 13:00 成交**之后**的 14:00 仍被归因曝光（SOLD 商品还在被展示）。
    // 它必须被 `AND a.occurred_at < p.sold_at` 排除，否则 `exposuresBeforeSale` 的 p90 会变成 3。
    {
      eventId: newId(),
      userId: userAId,
      listingId: lifecycleListingIds.n1,
      eventType: 'IMPRESSION',
      requestId: w2c,
      position: 0,
      occurredAt: new Date('2026-01-20T14:00:00Z'),
    },
    // 回归钉子 2：n2 的 grade 1 事件（DETAIL_VIEW 11:15）早于任何 grade ≥ 2 意向（CHAT_START 12:00）。
    // 若"有效意向"阈值放宽成 `>= 1`，首次意向会提前到 11:15（+3.25h），median 不再是 3.5。
    {
      eventId: newId(),
      userId: userAId,
      listingId: lifecycleListingIds.n2,
      eventType: 'DETAIL_VIEW',
      requestId: w2,
      position: 1,
      occurredAt: new Date('2026-01-20T11:15:00Z'),
    },
    // 零"成交前曝光"的成交商品：n4 / n5 各只有一条窗口内带归因的 PURCHASE，
    // 成交前一条归因曝光都没有 ⇒ 它们的 `exposuresBeforeSale` 必须是 0。
    {
      eventId: newId(),
      userId: userAId,
      listingId: lifecycleListingIds.n4,
      eventType: 'PURCHASE',
      requestId: w2c,
      position: null,
      occurredAt: new Date('2026-01-20T16:00:00Z'),
    },
    {
      eventId: newId(),
      userId: userBId,
      listingId: lifecycleListingIds.n5,
      eventType: 'PURCHASE',
      requestId: w2c,
      position: null,
      occurredAt: new Date('2026-01-20T17:00:00Z'),
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
    // 生命周期三项的空样本是 `{ count: 0, median: null, p90: null }`，不是 0 小时。
    expect(row.lifecycle).toEqual({
      newListingTimeToFirstExposureHours: { count: 0, median: null, p90: null },
      firstPublishToFirstIntentHours: { count: 0, median: null, p90: null },
      exposuresBeforeSale: { count: 0, median: null, p90: null },
    })
  })

  test('生命周期三项：只认窗口内带归因的事件，分位用 percentile_disc（最近秩、不插值）', async () => {
    const row = await store.getRecommendationMetrics({ since: SINCE2, until: UNTIL2 })

    // 新商品首次曝光：n1 +2h、n2 +3h、n3 +4h。
    expect(row.lifecycle.newListingTimeToFirstExposureHours).toEqual({
      count: 3,
      median: 3,
      p90: 4,
    })
    // 首发 → 首意向：n1 +3.5h（FAVORITE）、n2 +4h（CHAT_START）；n3 那条 FAVORITE 没有归因，不算；
    // n2 的 DETAIL_VIEW（+3.25h）是 grade 1，被阈值排除（放宽成 `>= 1` 这条断言就会红）。
    // 最近秩中位数 = 第 ceil(0.5 * 2) = 1 个 = 3.5（线性插值会得 3.75，这条断言把口径钉死）。
    expect(row.lifecycle.firstPublishToFirstIntentHours).toEqual({ count: 2, median: 3.5, p90: 4 })
    // 成交前曝光：n1 = 2 条（10:00 / 12:30，都在 13:00 成交之前）、l3 = 1 条（14:00）、
    // n4 / n5 = **0** 条（窗口内有带归因的成交，成交前一条归因曝光都没有）。
    // n1 在 14:00 还有一条**成交后**的曝光，必须被 `occurred_at < sold_at` 排除（删掉谓词 p90 会变 3）。
    // l3 / n4 / n5 的 created_at 在窗口外仍计入（这一项不看商品创建时刻）。
    // 分母必须是"窗口内发生过成交的商品"：`[0,0,1,2]` 的最近秩中位数 = 第 ceil(0.5 × 4) = 2 个 = 0；
    // 用 INNER JOIN 把零曝光样本丢掉就退回 `[1,2]` ⇒ count 2 / median 1 —— 这条断言是该回归的钉子
    // （p90 两种口径都是 2，钉不住），口径与离线 `apps/worker/src/jobs/recommendation/eval.ts` 的
    // `exposuresBeforeSale.push(times.filter((at) => at < soldAt).length)` 一致。
    expect(row.lifecycle.exposuresBeforeSale).toEqual({ count: 4, median: 0, p90: 2 })
  })

  test('窗口内有归因曝光、但商品不是窗口内创建 → 前两项仍为空（只统计窗口内新建）', async () => {
    const row = await store.getRecommendationMetrics({ since: SINCE, until: UNTIL })

    // 窗口内有 3 条归因曝光，但 l1/l2/l3 的 created_at 都落在窗口之外 ⇒ 前两项没有样本。
    expect(row.attributedImpressions).toBe(3)
    expect(row.lifecycle.newListingTimeToFirstExposureHours).toEqual({
      count: 0,
      median: null,
      p90: null,
    })
    expect(row.lifecycle.firstPublishToFirstIntentHours).toEqual({
      count: 0,
      median: null,
      p90: null,
    })
  })
})
