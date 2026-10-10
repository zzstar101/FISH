import { describe, expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { VISUAL_SEARCH_STRATEGY_VERSION } from './ranking'
import {
  VISUAL_SEARCH_SORTS,
  VISUAL_SOLD_AVG_MIN_SAMPLES,
  VisualSearchRequestSchema,
  VisualSearchResponseSchema,
  VisualSearchResultItemSchema,
  VisualSearchSortSchema,
  VisualSearchStatsSchema,
} from './schema'

/**
 * #324 M6 的契约面：排序档、结果项上的收藏数、成交均价统计。
 *
 * 这些字段是**跨端协议**，所以用例锁的是"能不能解析/会不会被拒"，不是服务端算得对不对
 * （那是 apps/api 的 service/ranking 单测与 core smoke 的事）。
 */

const listingId = encodePublicId(PUBLIC_ID_PREFIX.listing, '01930000-0000-7000-8000-0000000000b1')

const listingCard = {
  id: listingId,
  title: 'K380 键盘',
  priceCents: 16000,
  category: 'DIGITAL',
  condition: 'GOOD',
  status: 'ACTIVE',
  urgent: false,
  negotiable: true,
  free: false,
  coverUrl: null,
  createdAt: '2026-09-12T01:00:00.000Z',
  moderationStatus: null,
  wants: 0,
  views: 0,
}

const resultItem = { ...listingCard, favoriteCount: 7 }

const emptyStats = { soldAvgPriceCents: null, soldSampleCount: 0 }

describe('VisualSearchRequestSchema', () => {
  test('只发 objectKey 也能解析（老客户端与并行 M9 脚本仍在用这种调用）', () => {
    expect(VisualSearchRequestSchema.parse({ objectKey: 'visual-search/a/b.png' })).toEqual({
      objectKey: 'visual-search/a/b.png',
    })
  })

  test('五档排序值都能解析，且原样保留', () => {
    for (const sort of VISUAL_SEARCH_SORTS) {
      expect(VisualSearchRequestSchema.parse({ objectKey: 'k', sort }).sort).toBe(sort)
    }
    expect(VISUAL_SEARCH_SORTS).toEqual([
      'relevance',
      'popular',
      'newest',
      'price_asc',
      'condition',
    ])
  })

  test('非法排序值被拒（而不是被当成缺省值静默忽略）', () => {
    expect(VisualSearchRequestSchema.safeParse({ objectKey: 'k', sort: 'cheapest' }).success).toBe(
      false,
    )
    expect(VisualSearchSortSchema.safeParse(null).success).toBe(false)
  })

  test('objectKey 为空或超过 512 字符被拒', () => {
    expect(VisualSearchRequestSchema.safeParse({ objectKey: '' }).success).toBe(false)
    expect(VisualSearchRequestSchema.safeParse({ objectKey: 'x'.repeat(513) }).success).toBe(false)
  })

  test('多余字段被拒（strictObject：端上多传参数必须是 422 而不是被忽略）', () => {
    expect(
      VisualSearchRequestSchema.safeParse({ objectKey: 'k', sort: 'popular', limit: 10 }).success,
    ).toBe(false)
  })
})

describe('VisualSearchResultItemSchema', () => {
  test('收藏数必填，缺了就不是合法的结果项', () => {
    expect(VisualSearchResultItemSchema.safeParse(listingCard).success).toBe(false)
    expect(VisualSearchResultItemSchema.safeParse(resultItem).success).toBe(true)
  })

  test('收藏数必须是非负整数', () => {
    expect(
      VisualSearchResultItemSchema.safeParse({ ...resultItem, favoriteCount: 0 }).success,
    ).toBe(true)
    expect(
      VisualSearchResultItemSchema.safeParse({ ...resultItem, favoriteCount: -1 }).success,
    ).toBe(false)
    expect(
      VisualSearchResultItemSchema.safeParse({ ...resultItem, favoriteCount: 1.5 }).success,
    ).toBe(false)
  })

  test('继承 ListingCard 的全部字段，不是另起一个卡片形状', () => {
    const parsed = VisualSearchResultItemSchema.parse(resultItem)
    expect(parsed.title).toBe(listingCard.title)
    expect(parsed.condition).toBe('GOOD')
  })
})

describe('VisualSearchStatsSchema', () => {
  test('无样本时均价为 null 而不是 0（0 分是"有成交且均价 0"，两者不能混）', () => {
    expect(VisualSearchStatsSchema.parse(emptyStats)).toEqual(emptyStats)
    expect(VisualSearchStatsSchema.safeParse({ soldAvgPriceCents: null }).success).toBe(false)
  })

  test('均价必须是非负整数（四舍五入由服务端完成，端上不该收到小数分）', () => {
    expect(
      VisualSearchStatsSchema.safeParse({ soldAvgPriceCents: 1235, soldSampleCount: 3 }).success,
    ).toBe(true)
    expect(
      VisualSearchStatsSchema.safeParse({ soldAvgPriceCents: 1234.6, soldSampleCount: 3 }).success,
    ).toBe(false)
    expect(
      VisualSearchStatsSchema.safeParse({ soldAvgPriceCents: -1, soldSampleCount: 3 }).success,
    ).toBe(false)
  })

  test('最小样本阈值是契约常量，锁在服务端', () => {
    expect(VISUAL_SOLD_AVG_MIN_SAMPLES).toBe(3)
  })
})

describe('VisualSearchResponseSchema', () => {
  test('stats 必填：老响应体（没有统计）不再合法', () => {
    const response: Record<string, unknown> = {
      queryId: '44444444-4444-4444-8444-444444444444',
      interpretation: null,
      strategyVersion: VISUAL_SEARCH_STRATEGY_VERSION,
      embeddingModel: 'stub-visual-deterministic-v1',
      items: [resultItem],
      stats: emptyStats,
    }

    expect(VisualSearchResponseSchema.safeParse(response).success).toBe(true)
    const { stats, ...withoutStats } = response
    expect(stats).toEqual(emptyStats)
    expect(VisualSearchResponseSchema.safeParse(withoutStats).success).toBe(false)
  })

  test('items 里的每一项都必须带收藏数', () => {
    expect(
      VisualSearchResponseSchema.safeParse({
        queryId: '44444444-4444-4444-8444-444444444444',
        interpretation: null,
        strategyVersion: VISUAL_SEARCH_STRATEGY_VERSION,
        embeddingModel: 'stub-visual-deterministic-v1',
        items: [listingCard],
        stats: emptyStats,
      }).success,
    ).toBe(false)
  })
})
