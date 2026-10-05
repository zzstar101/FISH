import { describe, expect, test } from 'bun:test'
import type { ListingCard } from '@fish/contracts/listings/schema'
import { toMockListing } from '@/features/listing/adapt'

/**
 * `features/listing/adapt.ts` 的 `toMockListing` 投影判据。
 *
 * `wants` 取契约卡片的 `ListingCardSchema.wants`（= 该商品已建会话的买家数，与卖家在
 * 「想要的人」页看到的人数同源）—— 全站只有这一个「想要」口径，函数**不接受覆盖**：
 * 曾经留过一个第三参给识图结果页传它的 `favoriteCount`（收藏数），那会让同一个
 * 「N 人想要」标签在两个页面表示两件事，卖家点进「想要的人」必然对不上号。
 */
function card(overrides: Partial<ListingCard> = {}): ListingCard {
  return {
    id: 'l-1',
    title: '高等数学 同济第七版',
    priceCents: 3800,
    category: 'BOOKS',
    condition: 'LIKE_NEW',
    status: 'ACTIVE',
    urgent: false,
    negotiable: false,
    free: false,
    coverUrl: null,
    createdAt: '2026-09-20T00:00:00.000Z',
    moderationStatus: null,
    wants: 0,
    ...overrides,
  } as ListingCard
}

describe('toMockListing / wants', () => {
  test('原样取契约的 wants（含 0，0 是「还没人开过会话」的真值）', () => {
    expect(toMockListing(card({ wants: 0 })).wants).toBe(0)
    expect(toMockListing(card({ wants: 12 })).wants).toBe(12)
  })

  test('第二参 now 仍按位置生效（现有调用方不受影响）', () => {
    const now = Date.parse('2026-09-20T12:00:00.000Z')
    const listing = toMockListing(card({ wants: 3 }), now)
    expect(listing.createdHoursAgo).toBe(12)
    expect(listing.wants).toBe(3)
  })
})
