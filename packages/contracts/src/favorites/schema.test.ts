import { describe, expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import {
  FavoriteErrorCodeSchema,
  FavoriteStateSchema,
  MyFavoritesQuerySchema,
  MyFavoritesResponseSchema,
} from './schema'

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
}

const item = { listing: listingCard, favoritedAt: '2026-09-12T03:00:00.000Z' }

describe('myFavoritesQuerySchema', () => {
  test('defaults the limit and keeps the cursor optional', () => {
    expect(MyFavoritesQuerySchema.parse({})).toEqual({ limit: 20 })
    expect(MyFavoritesQuerySchema.parse({ limit: '5', cursor: 'abc' })).toEqual({
      limit: 5,
      cursor: 'abc',
    })
  })

  test('rejects a limit outside 1–50', () => {
    expect(MyFavoritesQuerySchema.safeParse({ limit: '0' }).success).toBe(false)
    expect(MyFavoritesQuerySchema.safeParse({ limit: '51' }).success).toBe(false)
  })

  test('rejects unknown parameters instead of ignoring them', () => {
    // 收藏夹由登录态决定，端上不能指定别人的 userId —— 多传即 422，把越权尝试暴露出来。
    expect(MyFavoritesQuerySchema.safeParse({ userId: listingId }).success).toBe(false)
  })
})

describe('myFavoritesResponseSchema', () => {
  test('parses a page with its full total', () => {
    const parsed = MyFavoritesResponseSchema.parse({
      items: [item],
      nextCursor: 'next',
      total: 3,
    })
    expect(parsed.items[0]?.listing.status).toBe('ACTIVE')
    expect(parsed.total).toBe(3)
  })

  test('keeps listings that are no longer on sale', () => {
    // 收藏行不随商品状态消失：下架与售出都要能进列表，客户端按 status 区分原因。
    for (const status of ['OFFLINE', 'SOLD', 'RESERVED'] as const) {
      const parsed = MyFavoritesResponseSchema.safeParse({
        items: [{ ...item, listing: { ...listingCard, status } }],
        nextCursor: null,
        total: 1,
      })
      expect(parsed.success).toBe(true)
    }
  })

  test('requires favoritedAt and the embedded card', () => {
    expect(
      MyFavoritesResponseSchema.safeParse({ items: [], nextCursor: null, total: 0 }).success,
    ).toBe(true)
    expect(
      MyFavoritesResponseSchema.safeParse({
        items: [{ listing: listingCard }],
        nextCursor: null,
        total: 1,
      }).success,
    ).toBe(false)
  })
})

describe('favoriteStateSchema', () => {
  test('carries the server conclusion for both directions', () => {
    expect(FavoriteStateSchema.parse({ favorited: true })).toEqual({ favorited: true })
    expect(FavoriteStateSchema.parse({ favorited: false })).toEqual({ favorited: false })
  })
})

describe('favoriteErrorCodeSchema', () => {
  test('freezes the single domain error code', () => {
    expect(FavoriteErrorCodeSchema.options).toEqual(['LISTING_NOT_FOUND'])
  })
})
