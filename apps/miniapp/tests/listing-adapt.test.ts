import { describe, expect, test } from 'bun:test'
import type { ListingCard } from '@fish/contracts/listings/schema'
import { toMockCardSeller, toMockListing } from '@/features/listing/adapt'

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

/**
 * `toMockCardSeller` 的头像判据（#618）。
 *
 * 契约的 `seller.avatarUrl` 可为 `null`（库里是无约束 text）。此前这里会把它换成
 * `AVATAR_BLOCKS` 的 1×1 占位块，于是「新用户没有头像」在端上表现为一块彩色方块/空白，
 * 而不是平台统一的默认头像。现在**原样保留 null**，由视图层 `components/user-avatar`
 * 画默认头像 —— 这条用例在改前会失败（那时拿到的是 data URI）。
 */
describe('toMockCardSeller / avatarUrl', () => {
  test('契约给 null 就保持 null，不塞占位块', () => {
    const seller = toMockCardSeller(
      card({
        seller: { id: 'u-1', nickname: '阿星', avatarUrl: null, authStatus: 'VERIFIED' },
      }),
    )
    expect(seller?.avatarUrl).toBeNull()
  })

  test('契约给了真头像就原样透传', () => {
    const seller = toMockCardSeller(
      card({
        seller: {
          id: 'u-1',
          nickname: '阿星',
          avatarUrl: 'https://cdn.example.com/a.png',
          authStatus: 'VERIFIED',
        },
      }),
    )
    expect(seller?.avatarUrl).toBe('https://cdn.example.com/a.png')
  })
})
