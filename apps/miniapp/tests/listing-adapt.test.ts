import { describe, expect, test } from 'bun:test'
import type { ListingCard } from '@fish/contracts/listings/schema'
import { toMockListing } from '@/features/listing/adapt'

/**
 * `features/listing/adapt.ts` 的 `toMockListing` 投影判据。
 *
 * 钉住的是一条**向后兼容**的通道（#324）：识图结果项的 `favoriteCount` 是契约给的真值
 * （`VisualSearchResultItemSchema` 把它挂在卡片**外层**），所以第三参 `wants` 要能透到
 * `MockListing.wants` 上；但第二参 `now` 的位置不能动 —— 全仓现有调用方
 * （`toMockListings`、`features/match/adapt.ts`、`pages/mylist`）都按位置传它。
 * 不传 `wants` 时必须仍是 `null`（铁律 1：不编造业务数据）。
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
    ...overrides,
  } as ListingCard
}

describe('toMockListing / wants', () => {
  test('不传 wants：仍是 null（没有数据源就不编数字）', () => {
    expect(toMockListing(card()).wants).toBeNull()
  })

  test('传了 wants：原样透传（含 0）', () => {
    expect(toMockListing(card(), undefined, 7).wants).toBe(7)
    expect(toMockListing(card(), undefined, 0).wants).toBe(0)
  })

  test('第二参 now 仍按位置生效（不做成选项对象，现有调用方不受影响）', () => {
    const now = Date.parse('2026-09-20T12:00:00.000Z')
    const listing = toMockListing(card(), now, 3)
    expect(listing.createdHoursAgo).toBe(12)
    expect(listing.wants).toBe(3)
  })
})
