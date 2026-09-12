import { describe, expect, test } from 'bun:test'
import type { z } from 'zod'
import { MatchListingJobPayloadSchema, MatchWishJobPayloadSchema } from './jobs'
import {
  ListingMatchItemSchema,
  ListingMatchListResponseSchema,
  MatchListQuerySchema,
  WishMatchItemSchema,
  WishMatchListResponseSchema,
  WishSummarySchema,
} from './schema'

/** 取校验失败的字段路径：断言"错误落在哪个参数"是契约的一部分（前端据此定位）。 */
function issuePaths(schema: z.ZodType, input: unknown): PropertyKey[][] {
  const result = schema.safeParse(input)
  return result.success ? [] : result.error.issues.map((issue) => issue.path)
}

// `z.uuid()` 会校验 RFC 版本位与变体位，随手编的 UUID 会被拒。
const wishId = '0d9c6f2a-1f3e-4a5b-8c7d-6e5f4a3b2c1d'
const listingId = '9a8b7c6d-5e4f-4a3b-8c1d-0e9f8a7b6c5d'

const validListingCard = {
  id: listingId,
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
} as const

describe('MatchListQuerySchema', () => {
  test('accepts exactly one target and defaults limit to 10', () => {
    expect(MatchListQuerySchema.parse({ wishId })).toEqual({ wishId, limit: 10 })
    expect(MatchListQuerySchema.parse({ listingId })).toEqual({ listingId, limit: 10 })
  })

  test('coerces limit from the query string', () => {
    expect(MatchListQuerySchema.parse({ wishId, limit: '3' }).limit).toBe(3)
  })

  // 两个都给（或都不给）都是调用方 bug；静默取其一会让前端拿到"不是自己问的那个"结果。
  test('rejects giving both targets or neither', () => {
    expect(issuePaths(MatchListQuerySchema, { wishId, listingId })).toEqual([['wishId']])
    expect(issuePaths(MatchListQuerySchema, {})).toEqual([['wishId']])
  })

  test('rejects an out-of-range limit', () => {
    expect(MatchListQuerySchema.safeParse({ wishId, limit: 0 }).success).toBe(false)
    expect(MatchListQuerySchema.safeParse({ wishId, limit: 51 }).success).toBe(false)
    expect(MatchListQuerySchema.safeParse({ wishId, limit: 50 }).success).toBe(true)
  })

  test('rejects an unknown query parameter instead of dropping it', () => {
    expect(MatchListQuerySchema.safeParse({ wishId, cursor: 'abc' }).success).toBe(false)
  })

  test('rejects a non-uuid target', () => {
    expect(MatchListQuerySchema.safeParse({ wishId: 'wish-1' }).success).toBe(false)
  })
})

describe('WishMatchListResponseSchema', () => {
  test('parses a listing card as the counterparty', () => {
    const parsed = WishMatchListResponseSchema.parse({
      total: 1,
      items: [
        {
          id: wishId,
          score: 100,
          createdAt: '2026-09-12T07:00:00.000Z',
          listing: validListingCard,
        },
      ],
    })
    expect(parsed.items[0]?.listing.title).toBe('罗技 K380 键盘')
  })

  test('rejects a score outside 0–100', () => {
    const item = {
      id: wishId,
      score: 101,
      createdAt: '2026-09-12T07:00:00.000Z',
      listing: validListingCard,
    }
    expect(WishMatchListResponseSchema.safeParse({ total: 1, items: [item] }).success).toBe(false)
  })

  // 拆解分项刻意不在读模型里：多回三个数会让"分数含义"变成线上协议的一部分。
  test('exposes only the total score, not the per-component scores', () => {
    expect(Object.keys(WishMatchItemSchema.shape)).toEqual(['id', 'score', 'createdAt', 'listing'])
    expect(Object.keys(ListingMatchItemSchema.shape)).toEqual(['id', 'score', 'createdAt', 'wish'])
  })
})

describe('ListingMatchListResponseSchema', () => {
  const validWish = {
    id: wishId,
    keyword: '机械键盘',
    category: 'DIGITAL',
    budgetMinCents: null,
    budgetMaxCents: 20000,
  }

  test('accepts a wish whose category and budgets are null', () => {
    const parsed = ListingMatchListResponseSchema.parse({
      total: 1,
      items: [
        {
          id: listingId,
          score: 88,
          createdAt: '2026-09-12T07:00:00.000Z',
          wish: { ...validWish, category: null, budgetMaxCents: null },
        },
      ],
    })
    expect(parsed.items[0]?.wish.category).toBeNull()
  })

  test('rejects a lowercase wish category', () => {
    expect(WishSummarySchema.safeParse({ ...validWish, category: 'digital' }).success).toBe(false)
  })
})

describe('job payload schemas', () => {
  test('accept the shapes written by #6 / #7', () => {
    expect(MatchListingJobPayloadSchema.parse({ listingId })).toEqual({ listingId })
    expect(MatchWishJobPayloadSchema.parse({ wishId })).toEqual({ wishId })
  })

  test('reject extra fields instead of ignoring them', () => {
    expect(MatchListingJobPayloadSchema.safeParse({ listingId, userId: wishId }).success).toBe(
      false,
    )
    expect(MatchWishJobPayloadSchema.safeParse({ wishId, listingId }).success).toBe(false)
  })

  test('reject a missing or non-uuid id', () => {
    expect(MatchListingJobPayloadSchema.safeParse({}).success).toBe(false)
    expect(MatchWishJobPayloadSchema.safeParse({ wishId: 'wish-1' }).success).toBe(false)
  })
})
