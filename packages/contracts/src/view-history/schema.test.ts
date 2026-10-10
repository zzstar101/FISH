import { describe, expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import {
  ClearViewHistoryResponseSchema,
  MyViewHistoryQuerySchema,
  MyViewHistoryResponseSchema,
  VIEW_HISTORY_RETENTION_DAYS,
  VIEW_HISTORY_RETENTION_MS,
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
  wants: 0,
  views: 0,
}

const item = { listing: listingCard, viewedAt: '2026-09-12T03:00:00.000Z' }

describe('viewHistoryRetention', () => {
  test('窗口是 30 天，毫秒常量与天数同源', () => {
    expect(VIEW_HISTORY_RETENTION_DAYS).toBe(30)
    expect(VIEW_HISTORY_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1_000)
  })
})

describe('myViewHistoryQuerySchema', () => {
  test('defaults the limit and keeps the cursor optional', () => {
    expect(MyViewHistoryQuerySchema.parse({})).toEqual({ limit: 20 })
    expect(MyViewHistoryQuerySchema.parse({ limit: '5', cursor: 'abc' })).toEqual({
      limit: 5,
      cursor: 'abc',
    })
  })

  test('rejects a limit outside 1–50', () => {
    expect(MyViewHistoryQuerySchema.safeParse({ limit: '0' }).success).toBe(false)
    expect(MyViewHistoryQuerySchema.safeParse({ limit: '51' }).success).toBe(false)
  })

  test('rejects unknown parameters instead of ignoring them', () => {
    // 浏览记录由登录态决定，端上不能指定别人的 userId —— 多传即 422，把越权尝试暴露出来。
    expect(MyViewHistoryQuerySchema.safeParse({ userId: listingId }).success).toBe(false)
  })
})

describe('myViewHistoryResponseSchema', () => {
  test('parses a page with its full total', () => {
    const parsed = MyViewHistoryResponseSchema.parse({
      items: [item],
      nextCursor: 'next',
      total: 3,
    })
    expect(parsed.items[0]?.listing.status).toBe('ACTIVE')
    expect(parsed.items[0]?.viewedAt).toBe('2026-09-12T03:00:00.000Z')
    expect(parsed.total).toBe(3)
  })

  test('keeps listings that are no longer on sale', () => {
    // 足迹行不随商品状态消失：下架与售出都要能进列表，客户端按 status 区分原因。
    for (const status of ['OFFLINE', 'SOLD', 'RESERVED'] as const) {
      const parsed = MyViewHistoryResponseSchema.safeParse({
        items: [{ ...item, listing: { ...listingCard, status } }],
        nextCursor: null,
        total: 1,
      })
      expect(parsed.success).toBe(true)
    }
  })

  test('requires viewedAt and the embedded card', () => {
    expect(
      MyViewHistoryResponseSchema.safeParse({ items: [], nextCursor: null, total: 0 }).success,
    ).toBe(true)
    expect(
      MyViewHistoryResponseSchema.safeParse({
        items: [{ listing: listingCard }],
        nextCursor: null,
        total: 1,
      }).success,
    ).toBe(false)
  })
})

describe('clearViewHistoryResponseSchema', () => {
  test('counts the rows it deleted (0 is a valid idempotent result)', () => {
    expect(ClearViewHistoryResponseSchema.parse({ deleted: 2 })).toEqual({ deleted: 2 })
    expect(ClearViewHistoryResponseSchema.parse({ deleted: 0 })).toEqual({ deleted: 0 })
    expect(ClearViewHistoryResponseSchema.safeParse({ deleted: -1 }).success).toBe(false)
  })
})
