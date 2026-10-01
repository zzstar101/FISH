import { describe, expect, mock, test } from 'bun:test'
import type { FavoriteItem as ContractFavoriteItem } from '@fish/contracts/favorites/schema'
import type { ListingCard } from '@fish/contracts/listings/schema'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import {
  DEMO_FAVORITES,
  emptyCopy,
  FAVORITE_SEGMENTS,
  type FavoriteItem,
  inSegment,
  itemsOf,
  loadDemoFavorites,
  toFavoriteItems,
} from '../src/pages/favorites/list'

/**
 * 「我的收藏」的纯逻辑（分段 / 空态文案 / 演示条数）。
 * 组件接线没有单测（本仓 tests/ 只有纯逻辑测试，无 Taro 组件渲染基建）。
 */

// 构建期注入的开关（`config/index.ts` 的 defineConstants）。必须在动态 import
// `@/features/fetchers` 之前定义，否则 `features/load-failure.ts` 在模块求值阶段就 ReferenceError。
// `@tarojs/taro` 一并顶掉：Bun 下加载真 Taro 会在求值阶段抛（手法同 `wishes-api.test.ts`）。
mock.module('@tarojs/taro', () => ({ default: {} }))
Object.assign(globalThis, { __DEMO_AUTH__: true, __ALLOW_MOCK_FALLBACK__: true })

/** 规范 UUIDv7 → 对应资源公开 ID（与 `wishes-api.test.ts` 同一手法） */
const uuid = (n: number) => `01930000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`
const LISTING_ID = encodePublicId(PUBLIC_ID_PREFIX.listing, uuid(11))
const SELLER_ID = encodePublicId(PUBLIC_ID_PREFIX.user, uuid(13))

/** 造一行：`goneReason` 一给就是失效行（与 fixture 同一口径） */
function item(over: Partial<FavoriteItem> & { id?: string } = {}): FavoriteItem {
  if (over.segment === 'gone') {
    return {
      id: 'x',
      category: 'OTHER',
      categoryText: '其他',
      title: 't',
      priceCents: 100,
      seller: 's',
      avatarUrl: '',
      verified: false,
      wants: 1,
      savedLabel: '刚刚收藏',
      coverUrl: '',
      demo: true,
      ...over,
    } as FavoriteItem
  }
  return {
    id: 'x',
    category: 'OTHER',
    categoryText: '其他',
    title: 't',
    priceCents: 100,
    seller: 's',
    avatarUrl: '',
    verified: false,
    wants: 1,
    savedLabel: '刚刚收藏',
    coverUrl: '',
    demo: true,
    segment: 'sale',
    ...over,
  } as FavoriteItem
}

describe('演示数据 —— 必须与「我的」页数字栏对得上', () => {
  /**
   * 「我的」页的收藏数**只有** `loadProfile()` 一条出口（`demoProfile()` 没导出，
   * 上面注释还写明它「只走失败回退这条路」）。所以这里不写死 8，而是让没有服务端的
   * 环境把它真的跑出来 —— 否则作者两处改一处（数字栏 9、本页 8）时这个测试照样绿，
   * 正是它要防的那种自相矛盾。
   */
  test('本页条数 = 「我的」页数字栏的收藏数（走 loadProfile 的演示回退）', async () => {
    const { loadProfile } = await import('@/features/fetchers')
    const profile = await loadProfile()
    expect(profile?.favoritesCount).toBe(DEMO_FAVORITES.length)
  })

  test('8 件 = 6 有效 + 2 失效', () => {
    expect(DEMO_FAVORITES.length).toBe(8)
    expect(itemsOf(DEMO_FAVORITES, 'sale').length).toBe(6)
    expect(itemsOf(DEMO_FAVORITES, 'gone').length).toBe(2)
  })

  test('id 唯一（列表 key 与「哪一行」的判据）', () => {
    expect(new Set(DEMO_FAVORITES.map((row) => row.id)).size).toBe(DEMO_FAVORITES.length)
  })

  test('每行的色块都取到了（分类基色 / 头像块，不新增色值）', () => {
    for (const row of DEMO_FAVORITES) {
      expect(row.coverUrl.startsWith('data:image/png;base64,')).toBe(true)
      expect(row.avatarUrl.startsWith('data:image/png;base64,')).toBe(true)
    }
  })
})

describe('分段 —— 两段互斥，一行只进一段', () => {
  test('FAVORITE_SEGMENTS 只有两段且顺序是 有效 → 失效', () => {
    expect(FAVORITE_SEGMENTS.map((seg) => seg.key)).toEqual(['sale', 'gone'])
  })

  test('itemsOf 按段取出，两段并集是全集', () => {
    const rows = [item({ id: 'a' }), item({ id: 'b', segment: 'gone' }), item({ id: 'c' })]
    expect(itemsOf(rows, 'sale').map((r) => r.id)).toEqual(['a', 'c'])
    expect(itemsOf(rows, 'gone').map((r) => r.id)).toEqual(['b'])
    expect(itemsOf(rows, 'sale').length + itemsOf(rows, 'gone').length).toBe(rows.length)
    // `itemsOf` 必须与 `inSegment` 同一口径（两处各写一遍谓词就会漂移）
    expect(itemsOf(rows, 'gone')).toEqual(rows.filter((r) => inSegment(r, 'gone')))
  })
})

describe('emptyCopy —— 端点上线后，「空」就是真的空', () => {
  test('有效段说「你还没有收藏」，不再自称「没有后端」', () => {
    const copy = emptyCopy('sale')
    /*
      #394 之后这一页读的是真接口，「列表为空」确实等于「你还没收藏过」。
      旧文案「服务端还没有收藏接口 / 只记在这台设备上」现在是假话，而且方向最坏：
      用户明明收藏过，页面却告诉他服务端没有这份数据。
    */
    expect(copy.title).toContain('还没有收藏')
    expect(copy.text).not.toContain('后端')
    expect(copy.text).not.toContain('接口')
    expect(copy.text).not.toContain('这台设备')
  })

  test('照稿：有效给「去逛逛」、失效给「回有效宝贝」', () => {
    expect(emptyCopy('sale').action).toBe('browse')
    expect(emptyCopy('gone').action).toBe('backToSale')
    expect(emptyCopy('sale').actionLabel).toBe('去逛逛')
    expect(emptyCopy('gone').actionLabel).toBe('回有效宝贝')
  })

  test('两段的文案各不相同（失效段要解释「谁会出现在这里」）', () => {
    expect(emptyCopy('sale').text).not.toBe(emptyCopy('gone').text)
    expect(emptyCopy('sale').title).not.toBe(emptyCopy('gone').title)
  })
})

/** 契约收藏行：只填本页真正读的字段，其余按 `ListingCardSchema` 的最小合法形态 */
function saved(
  over: {
    id?: string
    status?: ListingCard['status']
    category?: ListingCard['category']
    coverUrl?: string | null
    favoritedAt?: string
    seller?: ListingCard['seller']
  } = {},
): ContractFavoriteItem {
  return {
    listing: {
      id: over.id ?? LISTING_ID,
      title: '九成新山地车',
      priceCents: 38000,
      category: over.category ?? 'SPORTS',
      condition: 'GOOD',
      status: over.status ?? 'ACTIVE',
      urgent: false,
      negotiable: true,
      free: false,
      coverUrl: over.coverUrl === undefined ? null : over.coverUrl,
      createdAt: '2026-09-01T00:00:00.000Z',
      ...(over.seller === undefined ? {} : { seller: over.seller }),
      // 卡片契约要求这个字段（`.nullable()`，不是 optional）：买家视角恒 null
      moderationStatus: null,
    },
    favoritedAt: over.favoritedAt ?? '2026-09-30T00:00:00.000Z',
  }
}

describe('toFavoriteItems —— 契约行 → 本页行（#397 接真数据的那一步）', () => {
  test('分段完全由 listing.status 推出，失效原因要分开说', () => {
    const rows = toFavoriteItems(
      [
        saved({ status: 'ACTIVE' }),
        saved({ status: 'RESERVED' }),
        saved({ status: 'SOLD' }),
        saved({ status: 'OFFLINE' }),
      ],
      0,
    )
    // 在售与已预定都还看得见（详情页可见性同口径），只有卖掉 / 下架才算失效
    expect(rows.map((row) => row.segment)).toEqual(['sale', 'sale', 'gone', 'gone'])
    // 「被买走」和「被下架」对用户是两件事（一个等不到、一个可能重新上架），不能混成一句
    expect(
      itemsOf(rows, 'gone').map((row) => (row.segment === 'gone' ? row.goneReason : '')),
    ).toEqual(['已卖掉', '已下架'])
  })

  test('卖家取自卡片内嵌的 seller；缺席时不留编造的占位身份', () => {
    const withSeller = toFavoriteItems(
      [
        saved({
          seller: {
            id: SELLER_ID,
            nickname: '阿星',
            avatarUrl: 'data:image/png;base64,BBB',
            authStatus: 'VERIFIED',
          },
        }),
      ],
      0,
    )[0]
    expect(withSeller?.seller).toBe('阿星')
    expect(withSeller?.verified).toBe(true)
    expect(withSeller?.avatarUrl).toBe('data:image/png;base64,BBB')

    const withoutSeller = toFavoriteItems([saved()], 0)[0]
    // 昵称缺席就留空（页面不画这一行），但**不能编一个名字**
    expect(withoutSeller?.seller).toBe('')
    expect(withoutSeller?.verified).toBe(false)
    // 头像缺席落既有占位块（`features/listing/adapt.ts` 同一取法），不是空串
    expect(withoutSeller?.avatarUrl.startsWith('data:image/png;base64,')).toBe(true)
  })

  test('无图落分类基色块、分类名走两字表、真实行 demo 恒 false', () => {
    const row = toFavoriteItems([saved({ category: 'SPORTS' })], 0)[0]
    expect(row?.categoryText).toBe('运动')
    expect(row?.coverUrl.startsWith('data:image/png;base64,')).toBe(true)
    // `demo: false` 是「这是服务端真数据」的标记：页面据它决定能不能真取消收藏
    expect(row?.demo).toBe(false)

    const withCover = toFavoriteItems([saved({ coverUrl: 'https://cdn.example.com/a.png' })], 0)[0]
    expect(withCover?.coverUrl).toBe('https://cdn.example.com/a.png')
  })

  test('savedLabel 按收藏时间算，而且读的是传进来的 nowMs', () => {
    const now = Date.parse('2026-10-01T12:00:00.000Z')
    const same = saved({ favoritedAt: '2026-10-01T11:59:30.000Z' })
    const justNow = toFavoriteItems([same], now)[0]
    expect(justNow?.savedLabel).toContain('收藏')
    /*
      同一个 `favoritedAt` 换个 `nowMs` 必须换文案 —— 否则说明函数内部自己取了
      `Date.now()`，页面上「刚刚收藏」会永远停在写代码那天的口径。
    */
    expect(toFavoriteItems([same], now + 86_400_000)[0]?.savedLabel).not.toBe(justNow?.savedLabel)
  })
})

describe('loadDemoFavorites —— 一次读取返回新数组（下拉刷新不会改到 fixture）', () => {
  test('内容与 fixture 一致，但顶层不是同一个数组', async () => {
    const once = await loadDemoFavorites()
    expect(once.length).toBe(DEMO_FAVORITES.length)
    expect(once).not.toBe(DEMO_FAVORITES)
    expect(once.map((row) => row.id)).toEqual(DEMO_FAVORITES.map((row) => row.id))
  })
})
