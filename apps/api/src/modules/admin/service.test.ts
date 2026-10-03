import { expect, test } from 'bun:test'
import { createDefaultLatencyRecorder } from '../../observability/latency'
import type { MediaStorage } from '../uploads/storage'
import { AdminError } from './errors'
import { createAdminService, type RecommendationProcessMetrics } from './service'
import type { AdminStore, RecommendationMetricsRow } from './store'

// #286 复审：图片结算拒绝人工决策时，store 会返回 `media-*` 结果码，service 必须把它翻译成可解释的
// 409（而不是让管理员看到 500）。这里只测「结果码 → AdminError」这一段映射；store 侧的翻译
// （`ModerationSettlementError` → 结果码）由 `store.test.ts` 打真库覆盖。
function serviceWith(result: Awaited<ReturnType<AdminStore['decideModeration']>>) {
  const store = { decideModeration: async () => result } as unknown as AdminStore
  return createAdminService({ store, storage: {} as MediaStorage })
}

function input() {
  return {
    recordId: '00000000-0000-7000-8000-000000000000',
    actorUserId: '00000000-0000-7000-8000-000000000001',
    decision: 'ALLOW' as const,
    reason: '人工复核',
    requestId: 'admin-service-test-1',
  }
}

test('图已被人工阻断 → 409 且提示"不能放行"', async () => {
  const error = await serviceWith('media-blocked')
    .decideModeration(input())
    .catch((thrown: unknown) => thrown)

  expect(error).toBeInstanceOf(AdminError)
  expect(error).toMatchObject({
    status: 409,
    code: 'MODERATION_CONFLICT',
    message: '该商品的图片已被人工阻断，不能放行',
  })
})

test('结算过程失败 → 409 且提示可重试', async () => {
  const error = await serviceWith('media-settlement-failed')
    .decideModeration(input())
    .catch((thrown: unknown) => thrown)

  expect(error).toMatchObject({
    status: 409,
    code: 'MODERATION_CONFLICT',
    message: '图片结算失败，本次决策未生效，请重试',
  })
})

test('台账行 / 对象缺失 → 409 且提示人工核查（与可重试的失败区分）', async () => {
  const error = await serviceWith('media-settlement-data-missing')
    .decideModeration(input())
    .catch((thrown: unknown) => thrown)

  expect(error).toMatchObject({
    status: 409,
    code: 'MODERATION_CONFLICT',
    message: '该商品的审核图片台账或对象缺失，无法放行，请人工核查',
  })
})

// #323 R6：推荐指标端点只做「SQL 行 → 契约」的聚合，分母口径与 0/0 → null 都在这一段，
// 所以这里用 stub store 精确控制分子分母；真库的 SQL 口径由 store.recommendation-metrics.test.ts 覆盖。
const FIXED_NOW = new Date('2026-10-02T12:00:00Z')

function metricsRow(overrides: Partial<RecommendationMetricsRow> = {}): RecommendationMetricsRow {
  return {
    feedRequests: 0,
    degradedFeedRequests: 0,
    rankedFeedRequests: 0,
    emptyRankedFeedRequests: 0,
    snapshotItems: 0,
    snapshotDistinctPairs: 0,
    attributedEventCounts: new Map<string, number>(),
    attributedImpressions: 0,
    topSellerExposures: 0,
    top10SellerExposures: 0,
    staleListingExposures: 0,
    ...overrides,
  }
}

function metricsService(
  row: RecommendationMetricsRow,
  options: {
    processMetrics?: RecommendationProcessMetrics
    latency?: ReturnType<typeof createDefaultLatencyRecorder>
  } = {},
) {
  const calls: Array<{ since: Date; until: Date }> = []
  const store = {
    getRecommendationMetrics: async (criteria: { since: Date; until: Date }) => {
      calls.push(criteria)
      return row
    },
  } as unknown as AdminStore
  const service = createAdminService({
    store,
    storage: {} as MediaStorage,
    clock: () => FIXED_NOW,
    // 服务端依赖的是**读取函数**而非快照值（否则端点永远返回启动那一刻的 0）。
    ...(options.processMetrics
      ? {
          recommendationProcessMetrics: () =>
            options.processMetrics as RecommendationProcessMetrics,
        }
      : {}),
    ...(options.latency ? { latency: options.latency } : {}),
  })
  return { service, calls }
}

test('空窗口：计数全 0、所有比率 null（分母 0 不是"差到 0"）', async () => {
  const { service } = metricsService(metricsRow())
  const metrics = await service.getRecommendationMetrics({ window: '24h' })

  expect(metrics.funnel).toMatchObject({
    feedRequests: 0,
    degradedFeedRequests: 0,
    impressions: 0,
    detailViews: 0,
    favorites: 0,
    chats: 0,
    transactions: 0,
    purchases: 0,
    impressionToDetailRate: null,
    detailToFavoriteRate: null,
    detailToChatRate: null,
    chatToTransactionRate: null,
    transactionToPurchaseRate: null,
  })
  expect(metrics.guardrails).toMatchObject({
    emptyRankedFeedRate: null,
    repeatedExposureRate: null,
    topSellerExposureShare: null,
    top10SellerExposureShare: null,
    staleListingExposureRate: null,
    // PR-1 没接进程内计数：0 次尝试 → 分母 0 → null，而不是"失败率 0%"。
    eventWriteFailureRate: null,
    rateLimitedRequests: 0,
  })
})

test('窗口档位换算成左闭右开区间，生成时刻取自注入时钟', async () => {
  const cases = [
    { window: '24h' as const, ms: 86_400_000 },
    { window: '7d' as const, ms: 604_800_000 },
    { window: '30d' as const, ms: 2_592_000_000 },
  ]
  for (const item of cases) {
    const { service, calls } = metricsService(metricsRow())
    const metrics = await service.getRecommendationMetrics({ window: item.window })

    expect(metrics.window).toBe(item.window)
    expect(metrics.generatedAt).toBe(FIXED_NOW.toISOString())
    expect(calls[0]?.until).toEqual(FIXED_NOW)
    expect(calls[0]?.since).toEqual(new Date(FIXED_NOW.getTime() - item.ms))
  }
})

test('漏斗比率按带归因事件算，窗口内缺席的事件类型按 0', async () => {
  const { service } = metricsService(
    metricsRow({
      attributedEventCounts: new Map([
        ['IMPRESSION', 200],
        ['DETAIL_VIEW', 50],
        ['FAVORITE', 20],
        ['CHAT_START', 10],
        ['TRANSACTION_START', 4],
        ['PURCHASE', 2],
        // 未归因的事件不会出现在这张表里（SQL 侧 `request_id IS NOT NULL`）；乱入的键也不参与漏斗。
        ['LONG_VIEW', 999],
      ]),
    }),
  )
  const metrics = await service.getRecommendationMetrics({ window: '7d' })

  expect(metrics.funnel).toMatchObject({
    impressions: 200,
    detailViews: 50,
    favorites: 20,
    chats: 10,
    transactions: 4,
    purchases: 2,
    impressionToDetailRate: 0.25,
    detailToFavoriteRate: 0.4,
    detailToChatRate: 0.2,
    chatToTransactionRate: 0.4,
    transactionToPurchaseRate: 0.5,
  })
})

test('guardrail：空快照率 / 重复曝光率 / 卖家集中度 / 陈旧曝光率', async () => {
  const { service } = metricsService(
    metricsRow({
      rankedFeedRequests: 60,
      emptyRankedFeedRequests: 3,
      snapshotItems: 100,
      snapshotDistinctPairs: 90,
      attributedImpressions: 100,
      topSellerExposures: 40,
      top10SellerExposures: 70,
      staleListingExposures: 5,
    }),
  )
  const metrics = await service.getRecommendationMetrics({ window: '7d' })

  expect(metrics.guardrails).toMatchObject({
    emptyRankedFeedRate: 0.05,
    repeatedExposureRate: 0.1,
    topSellerExposureShare: 0.4,
    top10SellerExposureShare: 0.7,
    staleListingExposureRate: 0.05,
  })
})

test('进程内计数：写失败率分母是尝试次数，429 与拒收原因原样透出', async () => {
  const processMetrics: RecommendationProcessMetrics = {
    eventWriteAttempts: 4,
    eventWriteFailures: 1,
    rateLimitedRequests: 7,
    eventRejectionReasons: {
      attributionNotFound: 2,
      identityMismatch: 1,
      listingNotFound: 0,
      occurredAtOutOfRange: 3,
      serverConfirmedEventType: 4,
    },
  }
  const { service } = metricsService(metricsRow(), { processMetrics })
  const metrics = await service.getRecommendationMetrics({ window: '24h' })

  expect(metrics.guardrails.eventWriteFailureRate).toBe(0.25)
  expect(metrics.guardrails.rateLimitedRequests).toBe(7)
  expect(metrics.guardrails.eventRejectionReasons).toEqual({
    attributionNotFound: 2,
    identityMismatch: 1,
    listingNotFound: 0,
    occurredAtOutOfRange: 3,
    serverConfirmedEventType: 4,
  })

  // 同一实例被读两次不能互相影响（计数是进程级只读快照）。
  const again = await service.getRecommendationMetrics({ window: '24h' })
  expect(again.guardrails.eventWriteFailureRate).toBe(0.25)
})

test('进程内计数是每次请求现读的：不是启动时那份快照', async () => {
  // 用一个可变的累计值模拟真实计数器（`createRecommendationProcessMetrics().snapshot()`）。
  let attempts = 0
  let failures = 0
  const store = {
    getRecommendationMetrics: async () => metricsRow(),
  } as unknown as AdminStore
  const service = createAdminService({
    store,
    storage: {} as MediaStorage,
    clock: () => FIXED_NOW,
    recommendationProcessMetrics: () => ({
      eventWriteAttempts: attempts,
      eventWriteFailures: failures,
      rateLimitedRequests: 0,
      eventRejectionReasons: {
        attributionNotFound: 0,
        identityMismatch: 0,
        listingNotFound: 0,
        occurredAtOutOfRange: 0,
        serverConfirmedEventType: 0,
      },
    }),
  })

  attempts = 4
  failures = 1
  const first = await service.getRecommendationMetrics({ window: '24h' })
  expect(first.guardrails.eventWriteFailureRate).toBe(0.25)

  attempts = 8
  const second = await service.getRecommendationMetrics({ window: '24h' })
  expect(second.guardrails.eventWriteFailureRate).toBe(0.125)
})

test('延迟：进程内采样三项齐全，采样点只统计真实观测过的请求', async () => {
  const latency = createDefaultLatencyRecorder(() => FIXED_NOW)
  latency.observe('feed', 10)
  latency.observe('feed', 30)
  latency.observe('events', 4)
  latency.observe('pgvector', 8)

  const { service } = metricsService(metricsRow(), { latency })
  const metrics = await service.getRecommendationMetrics({ window: '24h' })

  expect(metrics.processStartedAt).toBe(FIXED_NOW.toISOString())
  const byMetric = new Map(metrics.latency.map((row) => [row.metric, row]))
  expect([...byMetric.keys()].sort()).toEqual(['events', 'feed', 'pgvector'])
  expect(byMetric.get('feed')).toMatchObject({
    count: 2,
    p50Ms: 10,
    p95Ms: 30,
    p99Ms: 30,
    maxMs: 30,
  })
  expect(byMetric.get('events')).toMatchObject({ count: 1, p50Ms: 4, p95Ms: 4, maxMs: 4 })
  expect(byMetric.get('pgvector')).toMatchObject({ count: 1, p50Ms: 8, maxMs: 8 })
})
