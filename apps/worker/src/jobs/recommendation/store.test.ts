/**
 * 离线评估取数层的集成测试（Issue #323 R6 / 设计 §4.3）。
 *
 * 这里只验证**取数口径**，指标口径由 `eval.test.ts` 的纯函数用例覆盖。重点三项：
 *   1. 事件归因**不用事件自带 `request_id`**，而是按「同身份 + 快照含该商品 + 落在 W 内」重算，
 *      并取**最早**的那次请求；
 *   2. 两个时间轴：请求按 `requested_at` 切窗、事件按 `occurred_at` 切窗；
 *   3. 可见性分母只有一份口径（ACTIVE + APPROVED + 未下架 + 窗口内已创建）。
 *
 * scratch 库模式与 `apps/api/src/modules/recommendation/store.test.ts` 一致：不污染开发库。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { RANK_FEATURE_KEYS } from '@fish/contracts/recommendation/rank'
import { createDb, type Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { listings } from '@fish/db/schema/listings'
import { recommendationEvents } from '@fish/db/schema/recommendation-events'
import { recommendationRequestItems } from '@fish/db/schema/recommendation-request-items'
import { recommendationRequests } from '@fish/db/schema/recommendation-requests'
import { users } from '@fish/db/schema/users'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { computeRankEvalMetrics } from './eval'
import { createRankEvalStore } from './store'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../../../packages/db/src/migrations', import.meta.url),
)

const scratchDatabase = `fish_rank_eval_store_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const SINCE = new Date('2026-01-10T00:00:00Z')
const UNTIL = new Date('2026-01-11T00:00:00Z')
/** 归因窗 W：30 分钟（与 `RANK_EVAL_ATTRIBUTION_WINDOW_MS` 同值，测试里显式写小值便于构造边界）。 */
const WINDOW_MS = 30 * 60_000

const admin = createDb(databaseUrl)
let db: Db
let store: ReturnType<typeof createRankEvalStore>
/** userId → 该用户的请求 id */
let userId: string
let sessionId: string
let requestR1: string
let requestR2: string
let requestR3: string
const listingIds = new Map<string, string>()

function listingId(key: string): string {
  const id = listingIds.get(key)
  if (id === undefined) throw new Error(`缺少测试商品 ${key}`)
  return id
}

async function insertListing(
  key: string,
  overrides: Partial<{
    status: 'ACTIVE' | 'RESERVED' | 'SOLD' | 'OFFLINE'
    moderationStatus: 'APPROVED' | 'BLOCKED' | 'REVIEW'
    governanceDelistedAt: Date
    createdAt: Date
  }> = {},
): Promise<void> {
  const id = newId()
  await db.insert(listings).values({
    id,
    listingNo: await reserveTestListingNo(db, id),
    sellerId: userId,
    title: `评估商品 ${key}`,
    description: '评估取数测试',
    priceCents: 1000,
    category: 'DIGITAL',
    condition: 'GOOD',
    ...overrides,
  })
  listingIds.set(key, id)
}

async function insertRequest(input: {
  userId: string | null
  anonymousSessionId: string | null
  requestedAt: Date
}): Promise<string> {
  const id = newId()
  await db.insert(recommendationRequests).values({
    id,
    userId: input.userId,
    anonymousSessionId: input.anonymousSessionId,
    strategyVersion: 'rec-v1-rule+interest-v1+recall-v1+rank-v1',
    requestedAt: input.requestedAt,
  })
  return id
}

async function insertItem(
  requestId: string,
  key: string,
  position: number,
  // 默认值**故意形状不符**（只有 semantic、没有另外 6 个键）：它让绝大多数行走"跳过"路径，
  // 从而验证"形状不符不能终止整次评估"（§11 第 12 条）。真实 7 键路径由下面最后一个用例专门覆盖。
  rankBreakdown: unknown = {
    semantic: { normalized: 0.5, weight: 0.35, contribution: 0.175 },
    missing: [],
  },
): Promise<void> {
  await db.insert(recommendationRequestItems).values({
    requestId,
    position,
    listingId: listingId(key),
    primarySource: 'fresh',
    sources: ['fresh'],
    rankScore: 0.25,
    // 列类型是 `Record<string, unknown>`；参数刻意是 `unknown`（好让用例塞任意形状的坏数据）。
    rankBreakdown: rankBreakdown as Record<string, unknown>,
  })
}

async function insertEvent(input: {
  key: string
  eventType: 'IMPRESSION' | 'DETAIL_VIEW' | 'FAVORITE' | 'QUICK_SKIP'
  occurredAt: Date
  requestId: string | null
  position: number | null
  userId: string | null
  anonymousSessionId: string | null
}): Promise<void> {
  await db.insert(recommendationEvents).values({
    eventId: newId(),
    listingId: listingId(input.key),
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    requestId: input.requestId,
    position: input.position,
    userId: input.userId,
    anonymousSessionId: input.anonymousSessionId,
  })
}

beforeAll(async () => {
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  db = createDb(scratchUrl)
  await migrate(db, { migrationsFolder })
  store = createRankEvalStore(db)

  const [user] = await db
    .insert(users)
    .values({
      studentNo: `rank-eval-store-${Date.now()}`,
      passwordHash: 'test-not-a-real-hash',
      nickname: '离线评估取数测试',
    })
    .returning({ id: users.id })
  if (!user) throw new Error('insert users 未返回行')
  userId = user.id
  sessionId = newId()

  // 可见性样本：A/B/C 可见；D 过审被拒；E 已下架；F 成交（SOLD）；G 在窗口之后创建。
  // 所有商品的 `created_at` 都显式落在窗口内：默认值是 `now()`，会让"窗口末可见"全被切掉。
  const inWindowCreatedAt = new Date('2026-01-09T00:00:00Z')
  await insertListing('A', { createdAt: inWindowCreatedAt })
  await insertListing('B', { createdAt: inWindowCreatedAt })
  await insertListing('C', { createdAt: inWindowCreatedAt })
  await insertListing('D', { createdAt: inWindowCreatedAt, moderationStatus: 'BLOCKED' })
  await insertListing('E', {
    createdAt: inWindowCreatedAt,
    governanceDelistedAt: new Date('2026-01-05T00:00:00Z'),
  })
  await insertListing('F', { createdAt: inWindowCreatedAt, status: 'SOLD' })
  await insertListing('G', { createdAt: new Date('2026-01-12T00:00:00Z') })

  // R1（登录用户）：B 第 0 位、A 第 1 位 —— B 在两次快照里都出现，用来验证"取最早"；
  // A 的等级比 B 高却排在后面，用来让 NDCG 不等于 1（排序不理想）。
  requestR1 = await insertRequest({
    userId,
    anonymousSessionId: null,
    requestedAt: new Date('2026-01-10T10:00:00Z'),
  })
  await insertItem(requestR1, 'B', 0)
  await insertItem(requestR1, 'A', 1)
  // R2（同一用户，20 分钟后）：B 第 0 位、C 第 1 位。
  requestR2 = await insertRequest({
    userId,
    anonymousSessionId: null,
    requestedAt: new Date('2026-01-10T10:20:00Z'),
  })
  await insertItem(requestR2, 'B', 0)
  await insertItem(requestR2, 'C', 1)
  // R3（匿名会话，10:05）：A 第 0 位 —— 与 R1 撞同一件商品，用来验证身份隔离。
  requestR3 = await insertRequest({
    userId: null,
    anonymousSessionId: sessionId,
    requestedAt: new Date('2026-01-10T10:05:00Z'),
  })
  await insertItem(requestR3, 'A', 0)

  // e1：客户端自称 request_id = R2，但 B 最早出现在 R1 的快照里 ⇒ 必须归 R1。
  await insertEvent({
    key: 'B',
    eventType: 'DETAIL_VIEW',
    occurredAt: new Date('2026-01-10T10:05:00Z'),
    requestId: requestR2,
    position: 0,
    userId,
    anonymousSessionId: null,
  })
  // e2：匿名会话的收藏 ⇒ 归 R3（同身份的 A 快照只有 R3）。
  await insertEvent({
    key: 'A',
    eventType: 'FAVORITE',
    occurredAt: new Date('2026-01-10T10:07:00Z'),
    requestId: requestR3,
    position: 0,
    userId: null,
    anonymousSessionId: sessionId,
  })
  // e3：超出归因窗（R2 在 10:20，事件在 13:20）⇒ 不归任何请求。
  await insertEvent({
    key: 'C',
    eventType: 'DETAIL_VIEW',
    occurredAt: new Date('2026-01-10T13:20:00Z'),
    requestId: requestR2,
    position: 1,
    userId,
    anonymousSessionId: null,
  })
  // e4：没带 request_id，但登录用户在 R1 看过 A ⇒ 归 R1（归因与客户端字段无关的另一面）；
  // 用 FAVORITE（grade 2）让 R1 的相关集出现等级差，NDCG 才有区分度。
  await insertEvent({
    key: 'A',
    eventType: 'FAVORITE',
    occurredAt: new Date('2026-01-10T10:10:00Z'),
    requestId: null,
    position: null,
    userId,
    anonymousSessionId: null,
  })
  // e5：D 从未出现在任何快照里 ⇒ 不归任何请求。
  await insertEvent({
    key: 'D',
    eventType: 'DETAIL_VIEW',
    occurredAt: new Date('2026-01-10T10:30:00Z'),
    requestId: null,
    position: null,
    userId,
    anonymousSessionId: null,
  })
  // e6：QUICK_SKIP 也参与归因（它只影响相关集，不影响归因）。
  await insertEvent({
    key: 'A',
    eventType: 'QUICK_SKIP',
    occurredAt: new Date('2026-01-10T10:06:00Z'),
    requestId: requestR3,
    position: 0,
    userId: null,
    anonymousSessionId: sessionId,
  })
  // e7：IMPRESSION 带 request_id/position（CHECK 约束要求），归 R1。
  await insertEvent({
    key: 'B',
    eventType: 'IMPRESSION',
    occurredAt: new Date('2026-01-10T10:02:00Z'),
    requestId: requestR1,
    position: 1,
    userId,
    anonymousSessionId: null,
  })
  // e8：窗口之前的事件 —— 取数侧按 occurred_at 切掉，绝不进数据集。
  await insertEvent({
    key: 'A',
    eventType: 'DETAIL_VIEW',
    occurredAt: new Date('2026-01-09T10:00:00Z'),
    requestId: null,
    position: null,
    userId,
    anonymousSessionId: null,
  })
})

afterAll(async () => {
  await db.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

describe('createRankEvalStore（取数口径）', () => {
  test('请求与快照：按 requested_at 切窗、按 position 排序、身份键区分登录与匿名', async () => {
    const dataset = await store.loadDataset({
      since: SINCE,
      until: UNTIL,
      attributionWindowMs: WINDOW_MS,
    })

    expect(dataset.requests.map((request) => request.requestId)).toEqual([
      requestR1,
      requestR3,
      requestR2,
    ])
    const r1 = dataset.requests.find((request) => request.requestId === requestR1)
    expect(r1?.identity).toBe(`user:${userId}`)
    expect(r1?.items.map((item) => [item.listingId, item.position])).toEqual([
      [listingId('B'), 0],
      [listingId('A'), 1],
    ])
    const r3 = dataset.requests.find((request) => request.requestId === requestR3)
    expect(r3?.identity).toBe(`anon:${sessionId}`)
    expect(r3?.items).toHaveLength(1)
  })

  test('事件归因：取最早的同身份快照请求，不信客户端 request_id，也不漏窗口边界', async () => {
    const dataset = await store.loadDataset({
      since: SINCE,
      until: UNTIL,
      attributionWindowMs: WINDOW_MS,
    })

    // 窗口外的事件（e8）不在数据集里。
    expect(dataset.events).toHaveLength(7)
    const attributed = new Map<string, (typeof dataset.events)[number][]>()
    for (const event of dataset.events) {
      const bucket = attributed.get(event.eventType)
      if (bucket === undefined) attributed.set(event.eventType, [event])
      else bucket.push(event)
    }

    const detailViews = attributed.get('DETAIL_VIEW') ?? []
    // 按 occurred_at 升序：e1（B，客户端自称 R2）→ R1；e5（D，无快照）→ null；e3（C，超窗）→ null。
    expect(detailViews.map((event) => [event.listingId, event.attributedRequestId])).toEqual([
      [listingId('B'), requestR1],
      [listingId('D'), null],
      [listingId('C'), null],
    ])
    // e2（匿名收藏 A）→ R3、e4（登录用户收藏 A）→ R1：同一件商品在两种身份下各自归因，不能互相顶替。
    expect((attributed.get('FAVORITE') ?? []).map((event) => event.attributedRequestId)).toEqual([
      requestR3,
      requestR1,
    ])
    // e6 匿名 QUICK_SKIP：负向事件一样要归因（剔除相关集时才知道剔谁的）。
    expect((attributed.get('QUICK_SKIP') ?? []).map((event) => event.attributedRequestId)).toEqual([
      requestR3,
    ])
    expect((attributed.get('IMPRESSION') ?? []).map((event) => event.attributedRequestId)).toEqual([
      requestR1,
    ])
  })

  test('可见性分母：只看窗口末 ACTIVE + APPROVED + 未下架 + 已创建的商品', async () => {
    const dataset = await store.loadDataset({
      since: SINCE,
      until: UNTIL,
      attributionWindowMs: WINDOW_MS,
    })

    const visible = new Set(dataset.visibleListings.map((listing) => listing.listingId))
    expect(visible).toEqual(new Set([listingId('A'), listingId('B'), listingId('C')]))
    // 快照/事件引用到的商品元数据都要能取到（D 有事件无快照，E/F 两者都没有 ⇒ 不在集合里）。
    const listed = new Set(dataset.listings.map((listing) => listing.listingId))
    expect(listed).toEqual(
      new Set([listingId('A'), listingId('B'), listingId('C'), listingId('D')]),
    )
  })

  test('limitRequests 只回放最近的 N 条请求（大库抽样用）', async () => {
    const dataset = await store.loadDataset({
      since: SINCE,
      until: UNTIL,
      attributionWindowMs: WINDOW_MS,
      limitRequests: 1,
    })
    expect(dataset.requests.map((request) => request.requestId)).toEqual([requestR2])
    // 事件不跟着截断（它们是窗口内的全部事实），只是归因候选变少。
    expect(dataset.events).toHaveLength(7)
  })

  test('端到端：这一批数据算出的样本量与排序质量符合手算', async () => {
    const dataset = await store.loadDataset({
      since: SINCE,
      until: UNTIL,
      attributionWindowMs: WINDOW_MS,
    })
    const metrics = computeRankEvalMetrics(dataset, { kValues: [1, 2] })

    // R1：B(grade1) 在 rank1、A(grade2) 在 rank2；R2：无正向事件；R3：A 的 FAVORITE 被同请求的 QUICK_SKIP 剔除。
    expect(metrics.sample.requests).toBe(3)
    expect(metrics.sample.evaluatedRequests).toBe(3)
    expect(metrics.sample.requestsWithoutPositiveSignal).toBe(2)
    expect(metrics.sample.snapshotItems).toBe(5)
    expect(metrics.sample.attributedEvents).toBe(5)

    const [atOne, atTwo] = metrics.quality
    expect(atOne?.k).toBe(1)
    expect(atOne?.requests).toBe(1)
    // 相关集 {A:2, B:1}：rank1 是 B（命中），漏了 A。
    expect(atOne?.recall).toBeCloseTo(0.5, 12)
    expect(atOne?.mrr).toBeCloseTo(1, 12)
    // NDCG@1 的 IDCG 同样截断到 K：DCG=1（B 的 gain 1）、IDCG=3（A 的 gain 3）⇒ 1/3。
    expect(atOne?.ndcg).toBeCloseTo(1 / 3, 12)

    expect(atTwo?.k).toBe(2)
    expect(atTwo?.recall).toBeCloseTo(1, 12)
    // DCG@2 = 1 + 3/log2(3)；IDCG@2 = 3 + 1/log2(3)。
    const dcg = 1 + 3 / Math.log2(3)
    const idcg = 3 + 1 / Math.log2(3)
    expect(atTwo?.ndcg).toBeCloseTo(dcg / idcg, 12)
  })

  test('rank_breakdown：7 个特征键齐全的行进分布，`missing` 里的键不进，形状不符只计数', async () => {
    // 前面所有快照行都是"形状不符"的默认值，真实路径（线上写入的 7 键 + missing）没被覆盖过；
    // 这里补一行合法数据，同时把"跳过"计数锁死（否则整批都被跳过也能"全绿"）。
    const normalizedByKey = {
      semantic: 0.4,
      wish: 0.9,
      category: 0.6,
      freshness: 0.2,
      popularity: 0.8,
      repeatedExposure: 0.1,
      negativeFeedback: 0.3,
    }
    // 形状就是线上排序层写进 `rank_breakdown` 的样子：7 个特征键 + `missing`。
    // 断言用 `as` 而不是注解：`{ missing: [...] }` 这个**初值**本身不满足下标签名，
    // 只有补齐 7 个键之后才满足——用注解会把这个"逐步填满"的写法挡在编译期。
    const breakdown = { missing: ['wish'] } as Record<
      string,
      { normalized: number; weight: number; contribution: number }
    > & {
      missing: string[]
    }
    for (const [key, normalized] of Object.entries(normalizedByKey)) {
      breakdown[key] = { normalized, weight: 0.1, contribution: normalized * 0.1 }
    }

    const request = await insertRequest({
      userId,
      anonymousSessionId: null,
      requestedAt: new Date('2026-01-10T10:40:00Z'),
    })
    await insertItem(request, 'C', 0, breakdown)

    const dataset = await store.loadDataset({
      since: SINCE,
      until: UNTIL,
      attributionWindowMs: WINDOW_MS,
    })
    const metrics = computeRankEvalMetrics(dataset, { kValues: [1] })

    // 合法的只有刚插入的这 1 行；R1×2 + R2×2 + R3×1 = 5 行仍是形状不符 ⇒ 只计数不抛错。
    expect(metrics.skippedBreakdownRows).toBe(5)
    expect(metrics.features.map((row) => row.key)).toEqual([...RANK_FEATURE_KEYS])
    for (const row of metrics.features) {
      if (row.key === 'wish') {
        // `missing` 里的键不进分布（它的 normalized 是"没信号"的占位值），但缺一次记一次。
        expect(row.samples).toBe(0)
        expect(row.missingCount).toBe(1)
        continue
      }
      expect(row.samples).toBe(1)
      expect(row.missingCount).toBe(0)
      expect(row.mean).toBeCloseTo(normalizedByKey[row.key], 12)
      expect(row.p50).toBeCloseTo(normalizedByKey[row.key], 12)
    }
  })
})
