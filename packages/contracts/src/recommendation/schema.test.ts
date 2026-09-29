import { describe, expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { z } from 'zod'
import {
  MAX_RECOMMENDATION_EVENT_METADATA_BYTES,
  RECOMMENDATION_STRATEGY_VERSION_NONE,
  RECOMMENDATION_THRESHOLDS,
  RecommendationEventBatchSchema,
  RecommendationEventInputSchema,
  RecommendationEventTypeSchema,
  RecommendationFeedQuerySchema,
  RecommendationFeedResponseSchema,
} from './schema'

/** 取校验失败的字段路径：断言"错误落在哪个参数"是契约的一部分（前端据此定位）。 */
function issuePaths(schema: z.ZodType, input: unknown): PropertyKey[][] {
  const result = schema.safeParse(input)
  return result.success ? [] : result.error.issues.map((issue) => issue.path)
}

// `z.uuid()` 会校验 RFC 版本位与变体位，随手编的 UUID 会被拒。
const eventId = '0d9c6f2a-1f3e-4a5b-8c7d-6e5f4a3b2c1d'
const requestId = '01930000-0000-7000-8000-0000000000aa'
const publicListingId = encodePublicId(
  PUBLIC_ID_PREFIX.listing,
  '01930000-0000-7000-8000-000000000011',
)

const detailView = {
  eventId,
  listingId: publicListingId,
  eventType: 'DETAIL_VIEW',
} as const

const impression = {
  ...detailView,
  eventType: 'IMPRESSION',
  requestId,
  position: 3,
  source: 'fresh',
  metadata: { visibleRatio: 0.8, durationMs: 1_400, pageIndex: 0 },
} as const

describe('RecommendationEventTypeSchema', () => {
  test('accepts the 12 event types frozen by #323', () => {
    const types = [
      'IMPRESSION',
      'DETAIL_VIEW',
      'LONG_VIEW',
      'IMAGE_VIEW',
      'QUICK_SKIP',
      'FAVORITE',
      'UNFAVORITE',
      'CHAT_START',
      'COMMENT',
      'TRANSACTION_START',
      'PURCHASE',
      'HIDE',
    ]
    for (const type of types) {
      expect(RecommendationEventTypeSchema.safeParse(type).success).toBe(true)
    }
    expect(RecommendationEventTypeSchema.options).toHaveLength(12)
  })

  test('rejects lowercase or renamed types instead of coercing', () => {
    for (const type of ['impression', 'Impression', 'VIEW', 'DETAILVIEW']) {
      expect(RecommendationEventTypeSchema.safeParse(type).success).toBe(false)
    }
  })
})

// 阈值是两端（miniapp 的 wx.createIntersectionObserver / PC 的 IntersectionObserver）共用的判定口径，
// 落进契约常量后任何改动都必须过这条测试 —— 否则两端会各自漂移。
describe('RECOMMENDATION_THRESHOLDS', () => {
  test('is frozen to the values agreed in review', () => {
    expect(RECOMMENDATION_THRESHOLDS).toEqual({
      impressionMinVisibleRatio: 0.5,
      impressionMinDurationMs: 1_000,
      quickSkipMaxDurationMs: 1_000,
      longViewMinDurationMs: 10_000,
    })
  })
})

describe('RecommendationEventInputSchema', () => {
  test('accepts a detail view with no recommendation context', () => {
    expect(RecommendationEventInputSchema.parse(detailView)).toEqual(detailView)
  })

  test('accepts a fully attributed impression', () => {
    expect(RecommendationEventInputSchema.parse(impression)).toEqual(impression)
  })

  // 只有从推荐 Feed 点进去的浏览才有来源；搜索/分类进详情时 requestId 必须允许缺省，
  // 否则前端只能编一个假 id，归因数据会被污染成"看起来来自推荐"。
  test('accepts an explicit null requestId for non-feed entry points', () => {
    expect(
      RecommendationEventInputSchema.safeParse({
        ...detailView,
        requestId: null,
        source: null,
        position: null,
      }).success,
    ).toBe(true)
  })

  test('requires requestId and position on impressions', () => {
    expect(
      issuePaths(RecommendationEventInputSchema, { ...impression, requestId: undefined }),
    ).toEqual([['requestId']])
    expect(
      issuePaths(RecommendationEventInputSchema, { ...impression, position: undefined }),
    ).toEqual([['position']])
    expect(issuePaths(RecommendationEventInputSchema, { ...impression, position: null })).toEqual([
      ['position'],
    ])
  })

  test('requires requestId and position on quick skips', () => {
    // QUICK_SKIP 的 metadata 白名单只放开 durationMs：换成曝光那份会连 metadata 一起报错。
    const quickSkip = {
      ...impression,
      eventType: 'QUICK_SKIP',
      requestId: null,
      metadata: { durationMs: 400 },
    }
    expect(issuePaths(RecommendationEventInputSchema, quickSkip)).toEqual([['requestId']])

    const quickSkipWithoutPosition = {
      ...quickSkip,
      requestId,
      position: undefined,
      metadata: { visibleRatio: 0.9 },
    }
    expect(issuePaths(RecommendationEventInputSchema, quickSkipWithoutPosition)).toEqual([
      ['metadata'],
      ['position'],
    ])
  })

  test('rejects an eventId that is not a UUID', () => {
    for (const bad of ['', 'event-1', '0d9c6f2a-1f3e-4a5b-8c7d-6e5f4a3b2c1']) {
      expect(
        RecommendationEventInputSchema.safeParse({ ...detailView, eventId: bad }).success,
      ).toBe(false)
    }
  })

  test('rejects a bare UUID or wrong-prefix listingId', () => {
    const bareUuid = '01930000-0000-7000-8000-000000000011'
    expect(
      RecommendationEventInputSchema.safeParse({ ...detailView, listingId: bareUuid }).success,
    ).toBe(false)
    expect(
      RecommendationEventInputSchema.safeParse({
        ...detailView,
        listingId: encodePublicId(PUBLIC_ID_PREFIX.user, bareUuid),
      }).success,
    ).toBe(false)
  })

  test('rejects unknown top-level fields instead of ignoring them', () => {
    expect(
      RecommendationEventInputSchema.safeParse({ ...detailView, userId: requestId }).success,
    ).toBe(false)
    expect(
      RecommendationEventInputSchema.safeParse({
        ...detailView,
        occurredAt: undefined,
        ip: '1.2.3.4',
      }).success,
    ).toBe(false)
  })

  test('accepts an offset timestamp and rejects a naive one', () => {
    expect(
      RecommendationEventInputSchema.safeParse({
        ...detailView,
        occurredAt: '2026-09-28T13:43:09.123+08:00',
      }).success,
    ).toBe(true)
    expect(
      RecommendationEventInputSchema.safeParse({
        ...detailView,
        occurredAt: '2026-09-28 13:43:09',
      }).success,
    ).toBe(false)
  })

  test('rejects a negative or absurd position', () => {
    expect(RecommendationEventInputSchema.safeParse({ ...impression, position: -1 }).success).toBe(
      false,
    )
    expect(RecommendationEventInputSchema.safeParse({ ...impression, position: 1.5 }).success).toBe(
      false,
    )
    expect(
      RecommendationEventInputSchema.safeParse({ ...impression, position: 10_001 }).success,
    ).toBe(false)
  })

  test('rejects an unknown recall source', () => {
    expect(
      RecommendationEventInputSchema.safeParse({ ...impression, source: 'trending' }).success,
    ).toBe(false)
  })
})

// metadata 是埋点表最容易变成隐私倾倒场的字段：白名单按 event_type 逐类收紧，
// 多一个键就整条 422，而不是"先存下来以后再说"。
describe('RecommendationEventInputSchema metadata whitelist', () => {
  test('accepts the numeric metadata declared for each type', () => {
    expect(RecommendationEventInputSchema.safeParse({ ...impression, metadata: {} }).success).toBe(
      true,
    )
    expect(RecommendationEventInputSchema.safeParse({ ...detailView, metadata: {} }).success).toBe(
      true,
    )
    expect(
      RecommendationEventInputSchema.safeParse({
        ...detailView,
        eventType: 'IMAGE_VIEW',
        metadata: { imageIndex: 2 },
      }).success,
    ).toBe(true)
  })

  test('rejects an undeclared metadata key', () => {
    expect(
      issuePaths(RecommendationEventInputSchema, {
        ...impression,
        metadata: { visibleRatio: 0.8, keyword: '机械键盘' },
      }),
    ).toEqual([['metadata']])
  })

  test('rejects any metadata on types that declare none', () => {
    for (const eventType of ['DETAIL_VIEW', 'FAVORITE', 'HIDE', 'PURCHASE'] as const) {
      expect(
        RecommendationEventInputSchema.safeParse({
          ...detailView,
          eventType,
          metadata: { reason: 'spam' },
        }).success,
      ).toBe(false)
    }
  })

  test('rejects a metadata value outside its declared range', () => {
    expect(
      RecommendationEventInputSchema.safeParse({
        ...impression,
        metadata: { visibleRatio: 1.5 },
      }).success,
    ).toBe(false)
    expect(
      RecommendationEventInputSchema.safeParse({
        ...impression,
        metadata: { durationMs: -1 },
      }).success,
    ).toBe(false)
  })

  test('keeps the serialized metadata cap far above any whitelisted payload', () => {
    // 白名单里目前只有数值字段，2KB 是给后续扩展留的兜底；这条测试锁住它没有被调小到误伤合法事件。
    expect(MAX_RECOMMENDATION_EVENT_METADATA_BYTES).toBe(2_048)
    const serialized = JSON.stringify(impression.metadata)
    expect(serialized.length).toBeLessThan(MAX_RECOMMENDATION_EVENT_METADATA_BYTES)
  })
})

describe('RecommendationEventBatchSchema', () => {
  test('accepts 1 to 50 events', () => {
    expect(RecommendationEventBatchSchema.safeParse({ events: [detailView] }).success).toBe(true)
    expect(
      RecommendationEventBatchSchema.safeParse({
        events: Array.from({ length: 50 }, (_, index) => ({ ...detailView, position: index })),
      }).success,
    ).toBe(true)
  })

  test('rejects an empty batch and one over the cap', () => {
    expect(RecommendationEventBatchSchema.safeParse({ events: [] }).success).toBe(false)
    expect(
      RecommendationEventBatchSchema.safeParse({
        events: Array.from({ length: 51 }, () => detailView),
      }).success,
    ).toBe(false)
  })

  test('reports the index of the offending event', () => {
    expect(
      issuePaths(RecommendationEventBatchSchema, {
        events: [detailView, { ...impression, requestId: null }],
      }),
    ).toEqual([['events', 1, 'requestId']])
  })
})

describe('RecommendationFeedQuerySchema', () => {
  test('defaults limit to 20 and coerces the query string', () => {
    expect(RecommendationFeedQuerySchema.parse({})).toEqual({ limit: 20 })
    expect(RecommendationFeedQuerySchema.parse({ limit: '5' }).limit).toBe(5)
  })

  // 推荐入口一旦长出 sort/q/category，就变成 `GET /listings` 的复制品，两者迟早被合并。
  test('rejects listing-query parameters', () => {
    for (const query of [
      { sort: 'newest' },
      { q: '键盘' },
      { category: 'DIGITAL' },
      { offset: 20 },
    ]) {
      expect(RecommendationFeedQuerySchema.safeParse(query).success).toBe(false)
    }
  })

  test('rejects an out-of-range limit', () => {
    expect(RecommendationFeedQuerySchema.safeParse({ limit: 0 }).success).toBe(false)
    expect(RecommendationFeedQuerySchema.safeParse({ limit: 51 }).success).toBe(false)
    expect(RecommendationFeedQuerySchema.safeParse({ limit: 50 }).success).toBe(true)
  })
})

describe('RecommendationFeedResponseSchema', () => {
  const validListingCard = {
    id: publicListingId,
    title: '罗技 K380 键盘',
    priceCents: 16000,
    category: 'DIGITAL',
    condition: 'GOOD',
    status: 'ACTIVE',
    urgent: false,
    negotiable: true,
    free: false,
    coverUrl: null,
    createdAt: '2026-09-12T07:00:00.000Z',
    moderationStatus: null,
  }

  test('parses the #323 §M7 shape', () => {
    const parsed = RecommendationFeedResponseSchema.parse({
      requestId,
      strategyVersion: RECOMMENDATION_STRATEGY_VERSION_NONE,
      items: [validListingCard],
      nextCursor: null,
    })
    expect(parsed.items[0]?.title).toBe('罗技 K380 键盘')
    expect(parsed.requestId).toBe(requestId)
  })

  // 内部分数（rankScore / 特征）不进 HTTP 契约：字段一旦存在，客户端迟早会展示它。
  // `ListingCardSchema` 是普通 `z.object`（见 listings/schema.ts:154），多给的键会被剥掉——
  // 这里断言的是"服务端就算塞了 rankScore，也到不了客户端"，而不是"多一个键就 500"。
  test('exposes only requestId, strategyVersion, items and nextCursor', () => {
    expect(Object.keys(RecommendationFeedResponseSchema.shape).sort()).toEqual([
      'items',
      'nextCursor',
      'requestId',
      'strategyVersion',
    ])
    const parsed = RecommendationFeedResponseSchema.parse({
      requestId,
      strategyVersion: RECOMMENDATION_STRATEGY_VERSION_NONE,
      items: [{ ...validListingCard, rankScore: 0.87 }],
      nextCursor: null,
    })
    expect(Object.keys(parsed.items[0] ?? {})).not.toContain('rankScore')
  })

  test('rejects a non-uuid requestId and a missing strategyVersion', () => {
    expect(
      RecommendationFeedResponseSchema.safeParse({
        requestId: 'req-1',
        strategyVersion: RECOMMENDATION_STRATEGY_VERSION_NONE,
        items: [],
        nextCursor: null,
      }).success,
    ).toBe(false)
    expect(
      RecommendationFeedResponseSchema.safeParse({
        requestId,
        items: [],
        nextCursor: null,
      }).success,
    ).toBe(false)
  })

  test('pins the R1 strategy version', () => {
    expect(RECOMMENDATION_STRATEGY_VERSION_NONE).toBe('rec-v1-none')
  })
})
