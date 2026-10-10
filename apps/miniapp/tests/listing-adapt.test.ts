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
 *
 * `views` 取 `ListingCardSchema.views`（= 近 30 天去重浏览人数，#192）：它和 `wants` 并排画在
 * 详情页与「我的发布」行（稿「218 浏览 · 34 想要」），所以两个字段必须各走各的键。
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
    views: 0,
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

describe('toMockListing / views', () => {
  test('原样取契约的 views（含 0，0 是「窗口内没人看过」的真值）', () => {
    expect(toMockListing(card({ views: 0 })).views).toBe(0)
    expect(toMockListing(card({ views: 218 })).views).toBe(218)
  })

  // 串值守卫：`views` 写成 `card.wants` 时，两个页面各自都"看起来有数"，
  // 只有让两个字段取不同的值才能发现同一行上出现了两个一样的数字。
  test('views 与 wants 互不顶替：给不同的值，投影后仍各是各的', () => {
    const listing = toMockListing(card({ views: 218, wants: 34 }))
    expect(listing.views).toBe(218)
    expect(listing.wants).toBe(34)
  })
})
