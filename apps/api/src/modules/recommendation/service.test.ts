/**
 * 推荐服务的事件拒收分桶（Issue #323 R6 §10.1「拒绝原因计数」/ §6.3 的 7→5 映射）。
 *
 * 为什么需要这个文件：`apps/api/src/observability/recommendation-metrics.test.ts` 只证明
 * **计数器本身**能用（5 键齐全、逐桶累加、snapshot 是副本），而 `REJECTION_REASON_METRIC`
 * 那张 7→5 的映射表（`service.ts` 里 `as const satisfies Record<RecommendationRejection, …>`）
 * 只有**编译期**穷尽保护：把 `identity_mismatch` 错写到 `attributionNotFound` 上，编译过、
 * 端到端用例也过（那条只断言 `serverConfirmedEventType`）。这里用桩 store 直接驱动真实的
 * `reject()` 分支，逐个钉住「哪个内部原因落到哪个桶」。
 *
 * 不连库、不起 app：`ingest` 只用到 store 的 4 个方法，其余依赖（listings/recall/interest）
 * 在本用例里不会被触碰，因此用空对象桩。
 *
 * 注意桩的两套 id：事件里带的是**公开 id**（`ingest` 会 `decodePublicId` 成内部 id），而
 * `findExistingListingIds` 收到/返回的都是**内部 id**——两者混用会让所有事件都被判成
 * `listingNotFound`（第一版就这么错过）。
 */

import { describe, expect, spyOn, test } from 'bun:test'
import { RANK_REPEATED_EXPOSURE_COOLDOWN_THRESHOLD } from '@fish/contracts/recommendation/rank'
import type { RecallChannel } from '@fish/contracts/recommendation/recall'
import {
  RECOMMENDATION_STRATEGY_VERSION_NONE,
  type RecommendationEventInput,
} from '@fish/contracts/recommendation/schema'
import { newId } from '@fish/db/ids'
import type { ExposureHistory } from '@fish/db/recall-store'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { createRecommendationProcessMetrics } from '../../observability/recommendation-metrics'
import type { ListingService } from '../listings/service'
import type { InterestRefreshQueue } from './interest-queue'
import type { RecommendationRecall } from './recall/service'
import { createRecommendationService } from './service'
import type {
  RecommendationEventRecord,
  RecommendationItemAttribution,
  RecommendationRequestItemRecord,
  RecommendationRequestRow,
  RecommendationStore,
} from './store'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222'
const SESSION_ID = '33333333-3333-4333-8333-333333333333'
/** 任意「非降级」策略版本：排序模式下才走快照归因（`rec-v1-none` 是 R1 的透传）。 */
const RANKED_VERSION = 'rec-v1-rule+interest-v1+recall-v1+rank-v1'
const DAY_MS = 24 * 60 * 60 * 1000

/** 一件商品的两个 id：内部 id（裸 uuid）给 store，公开 id（`lst_…` 品牌类型）给客户端事件。 */
function listing() {
  const id = newId()
  return { id, publicId: encodePublicId(PUBLIC_ID_PREFIX.listing, id) }
}

function event(
  listingPublicId: RecommendationEventInput['listingId'],
  overrides: Partial<RecommendationEventInput> = {},
): RecommendationEventInput {
  return {
    eventId: crypto.randomUUID(),
    listingId: listingPublicId,
    eventType: 'DETAIL_VIEW',
    ...overrides,
  }
}

function requestRow(
  id: string,
  overrides: Partial<RecommendationRequestRow> = {},
): RecommendationRequestRow {
  return {
    id,
    userId: null,
    anonymousSessionId: SESSION_ID,
    strategyVersion: RANKED_VERSION,
    ...overrides,
  }
}

/** 桩 store：只实现 `ingest` 走到的 4 个方法，其余留空（本用例不会调用）。 */
function createService(options: {
  existingListingIds?: string[]
  requests?: RecommendationRequestRow[]
  attributions?: RecommendationItemAttribution[]
  insertEvents?: (records: RecommendationEventRecord[]) => Promise<number>
}): {
  ingest: ReturnType<typeof createRecommendationService>['ingest']
  metrics: ReturnType<typeof createRecommendationProcessMetrics>
  attempts: () => number
} {
  const metrics = createRecommendationProcessMetrics()
  let attempts = 0
  const store = {
    findExistingListingIds: async (ids: string[]) =>
      ids.filter((id) => (options.existingListingIds ?? []).includes(id)),
    findRequests: async (ids: string[]) =>
      (options.requests ?? []).filter((row) => ids.includes(row.id)),
    findRequestItemAttribution: async () => options.attributions ?? [],
    insertEvents: async (records: RecommendationEventRecord[]) => {
      attempts += 1
      return options.insertEvents ? await options.insertEvents(records) : records.length
    },
  } as unknown as RecommendationStore

  const service = createRecommendationService({
    store,
    listings: {} as unknown as Pick<ListingService, 'listFeed' | 'listCardsByIds'>,
    recall: {} as unknown as RecommendationRecall,
    interest: {} as unknown as InterestRefreshQueue,
    metrics,
  })

  return { ingest: service.ingest, metrics, attempts: () => attempts }
}

describe('ingest 的拒收原因分桶（#323 R6 §6.3 的 7→5 映射）', () => {
  test('服务端确证类事件（PURCHASE/CHAT_START 等）→ serverConfirmedEventType', async () => {
    const item = listing()
    const { ingest, metrics } = createService({ existingListingIds: [item.id] })

    const response = await ingest({
      viewerId: USER_ID,
      events: [
        event(item.publicId, { eventType: 'PURCHASE' }),
        event(item.publicId, { eventType: 'CHAT_START' }),
      ],
    })

    expect(response).toEqual({ accepted: 0, duplicates: 0, rejected: 2 })
    const snapshot = metrics.snapshot()
    expect(snapshot.eventRejectionReasons.serverConfirmedEventType).toBe(2)
    expect(snapshot.eventRejectionReasons.listingNotFound).toBe(0)
  })

  test('商品不存在 → listingNotFound（先于时间与归因判断）', async () => {
    const missing = listing()
    const { ingest, metrics, attempts } = createService({ existingListingIds: [] })

    const response = await ingest({ viewerId: null, events: [event(missing.publicId)] })

    expect(response).toEqual({ accepted: 0, duplicates: 0, rejected: 1 })
    const snapshot = metrics.snapshot()
    expect(snapshot.eventRejectionReasons.listingNotFound).toBe(1)
    // 整批被拒收时**没有发生写入**，不记尝试（否则"全是伪造事件"的批会稀释失败率）。
    expect(snapshot.eventWriteAttempts).toBe(0)
    expect(attempts()).toBe(0)
  })

  test('occurredAt 过旧 / 超前 → 同一个 occurredAtOutOfRange 桶', async () => {
    const item = listing()
    const { ingest, metrics } = createService({ existingListingIds: [item.id] })
    const now = Date.now()

    const response = await ingest({
      viewerId: null,
      events: [
        event(item.publicId, { occurredAt: new Date(now - 181 * DAY_MS).toISOString() }),
        event(item.publicId, { occurredAt: new Date(now + DAY_MS).toISOString() }),
      ],
    })

    expect(response.rejected).toBe(2)
    expect(metrics.snapshot().eventRejectionReasons.occurredAtOutOfRange).toBe(2)
  })

  test('requestId 在库里查不到 → attributionNotFound', async () => {
    const item = listing()
    const { ingest, metrics } = createService({ existingListingIds: [item.id] })

    const response = await ingest({
      viewerId: USER_ID,
      events: [event(item.publicId, { requestId: newId() })],
    })

    expect(response.rejected).toBe(1)
    expect(metrics.snapshot().eventRejectionReasons.attributionNotFound).toBe(1)
  })

  test('请求属于别人 → identityMismatch（不落到 attributionNotFound）', async () => {
    const item = listing()
    const requestId = newId()
    const { ingest, metrics } = createService({
      existingListingIds: [item.id],
      requests: [requestRow(requestId, { userId: OTHER_USER_ID })],
    })

    const response = await ingest({
      viewerId: USER_ID,
      events: [event(item.publicId, { requestId })],
    })

    expect(response.rejected).toBe(1)
    const snapshot = metrics.snapshot()
    expect(snapshot.eventRejectionReasons.identityMismatch).toBe(1)
    expect(snapshot.eventRejectionReasons.attributionNotFound).toBe(0)
  })

  test('排序模式下曝光不在快照里 → attributionNotFound（请求查不到与快照查不到合并成一个桶）', async () => {
    const item = listing()
    const requestId = newId()
    const { ingest, metrics } = createService({
      existingListingIds: [item.id],
      requests: [requestRow(requestId, { anonymousSessionId: SESSION_ID })],
      attributions: [],
    })

    const response = await ingest({
      viewerId: null,
      events: [
        event(item.publicId, {
          requestId,
          anonymousSessionId: SESSION_ID,
          eventType: 'IMPRESSION',
          position: 3,
        }),
      ],
    })

    expect(response.rejected).toBe(1)
    expect(metrics.snapshot().eventRejectionReasons.attributionNotFound).toBe(1)
  })

  test('降级请求（rec-v1-none）不查快照：IMPRESSION 照收，位置沿用 R1 口径', async () => {
    const item = listing()
    const requestId = newId()
    const { ingest, metrics } = createService({
      existingListingIds: [item.id],
      requests: [
        requestRow(requestId, {
          anonymousSessionId: SESSION_ID,
          strategyVersion: RECOMMENDATION_STRATEGY_VERSION_NONE,
        }),
      ],
      attributions: [],
    })

    const response = await ingest({
      viewerId: null,
      events: [
        event(item.publicId, {
          requestId,
          anonymousSessionId: SESSION_ID,
          eventType: 'IMPRESSION',
          position: 7,
          source: 'semantic',
        }),
      ],
    })

    expect(response).toEqual({ accepted: 1, duplicates: 0, rejected: 0 })
    const snapshot = metrics.snapshot()
    expect(snapshot.eventRejectionReasons.attributionNotFound).toBe(0)
    expect(snapshot.eventWriteAttempts).toBe(1)
    expect(snapshot.eventWriteFailures).toBe(0)
  })

  test('写入失败 → eventWriteFailures+1 且异常照抛（不吞 500 级故障）', async () => {
    const item = listing()
    const { ingest, metrics } = createService({
      existingListingIds: [item.id],
      insertEvents: async () => {
        throw new Error('insert 失败')
      },
    })

    await expect(
      ingest({
        viewerId: null,
        events: [event(item.publicId, { anonymousSessionId: SESSION_ID })],
      }),
    ).rejects.toThrow('insert 失败')

    const snapshot = metrics.snapshot()
    expect(snapshot.eventWriteAttempts).toBe(1)
    expect(snapshot.eventWriteFailures).toBe(1)
  })

  test('五个桶一起出现：键永远齐全，且每个桶各自累加', async () => {
    const item = listing()
    const missing = listing()
    const foreignRequestId = newId()
    const staleRequestId = newId()
    const { ingest, metrics } = createService({
      existingListingIds: [item.id],
      requests: [requestRow(foreignRequestId, { userId: OTHER_USER_ID })],
    })

    const response = await ingest({
      viewerId: USER_ID,
      events: [
        event(item.publicId, { eventType: 'COMMENT' }),
        event(missing.publicId),
        event(item.publicId, { occurredAt: new Date(Date.now() - 400 * DAY_MS).toISOString() }),
        event(item.publicId, { requestId: staleRequestId }),
        event(item.publicId, { requestId: foreignRequestId }),
        event(item.publicId, {
          requestId: newId(),
          anonymousSessionId: SESSION_ID,
          eventType: 'IMPRESSION',
        }),
      ],
    })

    expect(response.rejected).toBe(6)
    expect(metrics.snapshot().eventRejectionReasons).toEqual({
      attributionNotFound: 2,
      identityMismatch: 1,
      listingNotFound: 1,
      occurredAtOutOfRange: 1,
      serverConfirmedEventType: 1,
    })
    expect(metrics.snapshot().eventWriteAttempts).toBe(0)
  })
})

/**
 * 重复曝光冷却（#323 M6）在服务层的接线：`loadCooldown` 查历史 → 纯函数算集合 → 交给重排。
 *
 * 用桩 store 而不是连库：这里要证明的是**接线与取舍**（命中的被剔、查询炸了 fail-open），
 * SQL 与聚合值由 `packages/db/src/recall-store.test.ts` 负责。连库跑只会把这两件事混在一起，
 * 失败时分不清是判据错了还是接线错了。
 */
const NOW = new Date('2026-10-02T12:00:00.000Z')

function feedCandidate(listingId: string) {
  return {
    listingId,
    sellerId: newId(),
    category: 'OTHER' as const,
    recallSources: ['fresh'] as RecallChannel[],
    semanticScore: null,
    wishScore: null,
    popularity: null,
    userCategoryAffinity: null,
    freshness: 1,
    createdAt: NOW,
    alreadySeenCount: null,
    sellerExposure: 0,
  }
}

function feedCard(id: string) {
  return {
    id: encodePublicId(PUBLIC_ID_PREFIX.listing, id),
    title: '冷却用例商品',
    priceCents: 100,
    category: 'OTHER' as const,
    condition: 'GOOD' as const,
    status: 'ACTIVE' as const,
    urgent: false,
    negotiable: false,
    free: false,
    coverUrl: null,
    moderationStatus: null,
    // #460 起 `ListingCardSchema.wants` 必填（"已建会话的买家数"）：假卡片也要给，
    // 本用例只关心"客户端真正收到了哪几张"，值恒为 0。
    wants: 0,
    createdAt: NOW.toISOString(),
  }
}

/** 桩 store：只实现 `createRankedFeed` 走到的 3 个方法（其余不会被执行）。 */
function createFeedService(options: {
  listingIds: string[]
  history?: ExposureHistory[]
  historyError?: Error
}): {
  startFeed: ReturnType<typeof createRecommendationService>['startFeed']
  snapshotRows: () => readonly RecommendationRequestItemRecord[]
} {
  let records: readonly RecommendationRequestItemRecord[] = []
  const store = {
    findNegativeFeedbackEvents: async () => [],
    findExposureHistory: async () => {
      if (options.historyError !== undefined) throw options.historyError
      return options.history ?? []
    },
    createRequestWithItems: async (
      input: {
        id: string
        userId: string | null
        anonymousSessionId: string
        strategyVersion: string
      },
      rows: readonly RecommendationRequestItemRecord[],
    ) => {
      records = rows
      return requestRow(input.id, {
        userId: input.userId,
        anonymousSessionId: input.anonymousSessionId,
        strategyVersion: input.strategyVersion,
      })
    },
  } as unknown as RecommendationStore

  const service = createRecommendationService({
    store,
    // 卡片存在性不是本用例的关注点：只要客户端真的收到了哪几张，`listCardsByIds` 就原样返回哪几张。
    listings: {
      listFeed: async () => ({ items: [], nextCursor: null }),
      listCardsByIds: async (_viewerId: string | null, ids: string[]) =>
        new Map(ids.map((id) => [id, feedCard(id)])),
    },
    recall: {
      recall: async () => ({
        strategyVersion: 'recall-v1',
        candidates: options.listingIds.map(feedCandidate),
        channels: [],
        interest: { session: false, longTerm: false, combined: false },
        mergeDegradedReason: null,
      }),
    },
    interest: { enqueue: async () => {} },
    clock: () => NOW,
  })

  return { startFeed: service.startFeed, snapshotRows: () => records }
}

describe('重复曝光冷却的服务层接线（#323 M6）', () => {
  test('命中冷却的候选不进 items、也不进快照', async () => {
    const cooling = newId()
    const healthy = newId()
    const { startFeed, snapshotRows } = createFeedService({
      listingIds: [cooling, healthy],
      history: [
        {
          listingId: cooling,
          exposureCount: RANK_REPEATED_EXPOSURE_COOLDOWN_THRESHOLD,
          lastExposedAt: new Date(NOW.getTime() - 60 * 60 * 1_000),
          engagedCount: 0,
        },
      ],
    })

    const page = await startFeed({ viewerId: null, anonymousSessionId: SESSION_ID, limit: 20 })

    expect(page.response.items.map((item) => item.id)).toEqual([
      encodePublicId(PUBLIC_ID_PREFIX.listing, healthy),
    ])
    // 快照是归因真值：被冷却的候选连快照都不该有，否则它的 position 会占位、客户端的曝光序号错开。
    expect(snapshotRows().map((row) => row.listingId)).toEqual([healthy])
  })

  test('曝光历史查询失败 → 不报错、不做冷却（fail-open），候选照常发出', async () => {
    const first = newId()
    const second = newId()
    const { startFeed } = createFeedService({
      listingIds: [first, second],
      historyError: new Error('exposure history query 炸了'),
    })
    const warn = spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const page = await startFeed({ viewerId: null, anonymousSessionId: SESSION_ID, limit: 20 })

      // fail-open 的方向是"宁可多曝光"：查询故障不能让用户看到首页莫名少一批商品。
      expect(page.response.items.map((item) => item.id)).toEqual([
        encodePublicId(PUBLIC_ID_PREFIX.listing, first),
        encodePublicId(PUBLIC_ID_PREFIX.listing, second),
      ])
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  test('全部候选都命中冷却 → 本次不冷却，Feed 不为空（空 ranked feed 会被记成线上故障）', async () => {
    const first = newId()
    const second = newId()
    const cooling = (listingId: string): ExposureHistory => ({
      listingId,
      exposureCount: RANK_REPEATED_EXPOSURE_COOLDOWN_THRESHOLD,
      lastExposedAt: new Date(NOW.getTime() - 60 * 60 * 1_000),
      engagedCount: 0,
    })
    const { startFeed, snapshotRows } = createFeedService({
      listingIds: [first, second],
      history: [cooling(first), cooling(second)],
    })

    const page = await startFeed({ viewerId: null, anonymousSessionId: SESSION_ID, limit: 20 })

    // M6 是**单品**冷却，不是整页清空：整页都命中时退化为不冷却，否则服务端会写出一条 0 快照行的
    // ranked 请求，admin 的 `emptyRankedFeedRate` 会把它记成故障，而用户看到的是空白首页。
    expect(page.response.items.map((item) => item.id)).toEqual([
      encodePublicId(PUBLIC_ID_PREFIX.listing, first),
      encodePublicId(PUBLIC_ID_PREFIX.listing, second),
    ])
    expect(snapshotRows().map((row) => row.listingId)).toEqual([first, second])
  })
})
