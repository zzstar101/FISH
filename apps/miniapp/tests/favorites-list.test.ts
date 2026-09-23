import { describe, expect, mock, test } from 'bun:test'
import {
  DEMO_FAVORITES,
  emptyCopy,
  FAVORITE_SEGMENTS,
  type FavoriteItem,
  inSegment,
  itemsOf,
  loadDemoFavorites,
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

describe('emptyCopy —— 演示态与真实态的文案不能互换', () => {
  test('真实构建说的是缺口（收藏没有后端），不说「你恰好没有收藏」', () => {
    const real = emptyCopy('sale', false)
    expect(real.title).toContain('后端')
    // 缺口要指到具体的东西：服务端的收藏表与接口
    expect(real.text).toContain('接口')
    // 「还没有收藏的宝贝」会被读成用户自己没收藏过 —— 真实构建下不能这么说
    expect(real.title).not.toBe(emptyCopy('sale', true).title)
    expect(real.text).not.toContain('点一下 ♡')
  })

  test('演示态照稿：有效给「去逛逛」、失效给「回有效宝贝」', () => {
    expect(emptyCopy('sale', true).action).toBe('browse')
    expect(emptyCopy('gone', true).action).toBe('backToSale')
    expect(emptyCopy('sale', true).actionLabel).toBe('去逛逛')
    expect(emptyCopy('gone', true).actionLabel).toBe('回有效宝贝')
  })

  test('两段的文案各不相同（失效段要解释「谁会出现在这里」）', () => {
    for (const demo of [true, false]) {
      expect(emptyCopy('sale', demo).text).not.toBe(emptyCopy('gone', demo).text)
    }
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
