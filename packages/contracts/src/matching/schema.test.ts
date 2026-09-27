import { describe, expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
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
const publicWishId = encodePublicId(PUBLIC_ID_PREFIX.wish, '01930000-0000-7000-8000-000000000021')
const publicListingId = encodePublicId(
  PUBLIC_ID_PREFIX.listing,
  '01930000-0000-7000-8000-000000000011',
)
const publicMatchId = encodePublicId(PUBLIC_ID_PREFIX.match, '01930000-0000-7000-8000-000000000031')

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
} as const

describe('MatchListQuerySchema', () => {
  test('accepts exactly one target and defaults limit to 10', () => {
    expect(MatchListQuerySchema.parse({ wishId: publicWishId })).toEqual({
      wishId: publicWishId,
      limit: 10,
    })
    expect(MatchListQuerySchema.parse({ listingId: publicListingId })).toEqual({
      listingId: publicListingId,
      limit: 10,
    })
  })

  test('coerces limit from the query string', () => {
    expect(MatchListQuerySchema.parse({ wishId: publicWishId, limit: '3' }).limit).toBe(3)
  })

  // 两个都给（或都不给）都是调用方 bug；静默取其一会让前端拿到"不是自己问的那个"结果。
  test('rejects giving both targets or neither', () => {
    expect(
      issuePaths(MatchListQuerySchema, { wishId: publicWishId, listingId: publicListingId }),
    ).toEqual([['wishId']])
    expect(issuePaths(MatchListQuerySchema, {})).toEqual([['wishId']])
  })

  test('rejects an out-of-range limit', () => {
    expect(MatchListQuerySchema.safeParse({ wishId: publicWishId, limit: 0 }).success).toBe(false)
    expect(MatchListQuerySchema.safeParse({ wishId: publicWishId, limit: 51 }).success).toBe(false)
    expect(MatchListQuerySchema.safeParse({ wishId: publicWishId, limit: 50 }).success).toBe(true)
  })

  test('rejects an unknown query parameter instead of dropping it', () => {
    expect(MatchListQuerySchema.safeParse({ wishId: publicWishId, cursor: 'abc' }).success).toBe(
      false,
    )
  })

  test('rejects bare UUID and wrong-prefix targets', () => {
    for (const id of [wishId, publicListingId, 'wish-1']) {
      expect(MatchListQuerySchema.safeParse({ wishId: id }).success).toBe(false)
    }
  })
})

describe('WishMatchListResponseSchema', () => {
  test('parses a listing card as the counterparty', () => {
    const parsed = WishMatchListResponseSchema.parse({
      total: 1,
      items: [
        {
          id: publicMatchId,
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
      id: publicMatchId,
      score: 101,
      createdAt: '2026-09-12T07:00:00.000Z',
      listing: validListingCard,
    }
    expect(WishMatchListResponseSchema.safeParse({ total: 1, items: [item] }).success).toBe(false)
  })

  // 拆解分项刻意不在读模型里：多回三个数会让"分数含义"变成线上协议的一部分。
  // 用集合断言而不是 `toEqual([...])`：字段顺序不属于 HTTP 契约，重排不该让测试变红。
  test('exposes only the total score, not the per-component scores', () => {
    const wishItemFields = Object.keys(WishMatchItemSchema.shape).sort()
    const listingItemFields = Object.keys(ListingMatchItemSchema.shape).sort()
    expect(wishItemFields).toEqual(['createdAt', 'id', 'listing', 'score'])
    expect(listingItemFields).toEqual(['createdAt', 'id', 'score', 'wish'])
    for (const field of ['categoryScore', 'keywordScore', 'priceScore']) {
      expect(wishItemFields).not.toContain(field)
      expect(listingItemFields).not.toContain(field)
    }
  })
})

describe('ListingMatchListResponseSchema', () => {
  const validWish = {
    id: publicWishId,
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
          id: publicMatchId,
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
