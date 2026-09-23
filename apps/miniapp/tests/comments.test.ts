import { describe, expect, mock, test } from 'bun:test'
import {
  countBySegment,
  DEMO_MY_COMMENTS,
  demoCommentsEnabled,
  filterBySegment,
  kindLabel,
  type MyComment,
  SEGMENTS,
  segmentOf,
  shortCategoryLabel,
  starSlots,
  viewTargetOf,
} from '../src/features/comments/mine'
import { LISTING_BLOCKS } from '../src/mock/blocks'

/**
 * 「我的评论」纯逻辑的回归测试。
 *
 * 锁住的是**口径**而不是渲染（页面接线靠 code review 与端上演示）：
 *
 * 1. **商品留言不给默认满分**（本页最容易做错的一处）：契约里商品留言没有评分字段，
 *    所以 `rating` 恒为 `null`，星级必须整块不渲染。用 `starSlots(0)` / 写死 5 星顶替
 *    都是编造一个分数 —— 星级那组用例锁住这条。
 * 2. **三段互斥**：全部 = 商品留言 ∪ 交易评价，三个计数必须能互相对上（否则胶囊上的
 *    数字自相矛盾）。
 * 3. **演示数据自洽**：8 条 = 4 条商品留言 + 4 条交易评价，与 1版稿一致
 *    （`小程序1版comments.html` 的 DATA 就是 8 条 4+4）。锁住行数与构成，
 *    避免后来人加一条评价却忘了同步分段计数。
 *    ⚠️ 这 8 条**不与「我的」页任何数字栏对齐**：`demoProfile()`（`features/fetchers.ts`）
 *    里没有评论/评价计数，「我的」页图标栏的「评价」格也不带 `count`（不出红点）。
 *    别把这条当成跨页一致性要求 —— 它只是「与稿一致」。
 * 4. **演示开关是「与」不是「或」**：`demoCommentsEnabled` 的四种组合。
 *
 * 断言的期望值一律写**字面量**，不回抄实现里的三元表达式 —— 回抄会让「把两个标签
 * 写反」这种错误跟着一起写反、测试照样通过。
 */

function comment(overrides: Partial<MyComment> = {}): MyComment {
  return {
    id: 'C-test',
    kind: 'LISTING',
    category: 'DIGITAL',
    title: '测试商品',
    priceCents: 10000,
    text: '测试留言',
    timeLabel: '刚刚',
    rating: null,
    to: null,
    ...overrides,
  }
}

describe('我的评论 · 分段口径', () => {
  test('三段互斥：全部 = 商品留言 + 交易评价，三个计数互相能对上', () => {
    const items = [
      comment({ id: 'a' }),
      comment({ id: 'b', kind: 'TRADE', rating: 5, to: '某人' }),
      comment({ id: 'c', kind: 'TRADE', rating: 4, to: '另一个人' }),
    ]

    // 具体值断言（不回抄实现）：1 条留言 + 2 条评价 = 3 条
    expect(countBySegment(items)).toEqual({ all: 3, listing: 1, trade: 2 })
  })

  test('分段过滤：选「全部」不筛，选具体段只留那一段', () => {
    const items = [comment({ id: 'a' }), comment({ id: 'b', kind: 'TRADE', rating: 5, to: '某人' })]

    expect(filterBySegment(items, 'all')).toHaveLength(2)
    expect(filterBySegment(items, 'listing').map((item) => item.id)).toEqual(['a'])
    expect(filterBySegment(items, 'trade').map((item) => item.id)).toEqual(['b'])
    expect(filterBySegment([], 'all')).toEqual([])
  })

  test('分段键与 kind 是两套值，只在这一处换算（写错的话计数会全成 0）', () => {
    expect(segmentOf('LISTING')).toBe('listing')
    expect(segmentOf('TRADE')).toBe('trade')
    // 分段表的三项与换算结果一一对应
    expect(SEGMENTS.map((seg) => seg.key)).toEqual(['all', 'listing', 'trade'])
  })
})

describe('我的评论 · 星级', () => {
  /** 只关心「哪几格是满的」——`key` 是 React 列表用的稳定标识，不参与断言 */
  const filledOf = (rating: number | null) => starSlots(rating)?.map((slot) => slot.filled) ?? null

  test('评分是 null（商品留言）时不画星 —— 不是「0 星」也不是默认满分', () => {
    expect(starSlots(null)).toBeNull()
  })

  test('交易评价按分数点亮对应格数', () => {
    expect(filledOf(5)).toEqual([true, true, true, true, true])
    expect(filledOf(4)).toEqual([true, true, true, true, false])
    expect(filledOf(0)).toEqual([false, false, false, false, false])
  })

  test('越界分数夹到 0~5，不画出多于 5 格的星', () => {
    expect(filledOf(9)).toEqual([true, true, true, true, true])
    expect(filledOf(-3)).toEqual([false, false, false, false, false])
  })
})

describe('我的评论 · 演示数据自洽', () => {
  test('8 条 = 4 条商品留言 + 4 条交易评价（与稿一致）', () => {
    expect(DEMO_MY_COMMENTS).toHaveLength(8)
    expect(countBySegment(DEMO_MY_COMMENTS)).toEqual({ all: 8, listing: 4, trade: 4 })
  })

  test('星级与评价对象只出现在交易评价上，商品留言一律为 null', () => {
    for (const item of DEMO_MY_COMMENTS) {
      if (item.kind === 'TRADE') {
        expect(item.rating).not.toBeNull()
        expect(item.to).not.toBeNull()
        continue
      }
      // 商品留言在契约里就没有评分字段与对方字段
      expect(item.rating).toBeNull()
      expect(item.to).toBeNull()
    }
  })

  test('每条都能画出来：色块分类、两字品类、标题/正文/时间都有值', () => {
    for (const item of DEMO_MY_COMMENTS) {
      // 色块：页面的 `blockOf` 拿 `LISTING_BLOCKS[category][0]`，缺键会静默退回 OTHER ——
      // 那会让这一条显示成「其他」的灰块，而品类小字仍写着真分类，自相矛盾。
      expect(LISTING_BLOCKS[item.category]?.[0]).toBeString()
      expect(shortCategoryLabel(item.category)).toHaveLength(2)
      expect(item.title.length).toBeGreaterThan(0)
      expect(item.text.length).toBeGreaterThan(0)
      expect(item.timeLabel.length).toBeGreaterThan(0)
    }
  })

  test('两条真实成交的评价时间晚于成交时间（订单页「已于 …」的日期）', () => {
    // 交易评价的时间是「面交完成之后」才有的事。稿子这两行写的是 5 月，而它们引用的
    // 成交在 8 月 —— 照抄会显示成「面交前两个月就评价了」。这里锁住两条真实成交的先后。
    const byId = new Map(DEMO_MY_COMMENTS.map((item) => [item.id, item]))
    expect(byId.get('C05')?.timeLabel).toBe('8 月 21 日') // t-104 完成于 2026-08-19
    expect(byId.get('C06')?.timeLabel).toBe('8 月 14 日') // t-106 完成于 2026-08-12
  })

  test('类型胶囊与「查看…」按钮的文案（字面量，不回抄实现的三元表达式）', () => {
    // 回抄实现的写法（`kindLabel(k) === (k === 'TRADE' ? '交易评价' : '商品留言')`）
    // 会让「把两个标签写反」跟着一起写反、断言照样通过 —— 这里写死期望值。
    expect(kindLabel('LISTING')).toBe('商品留言')
    expect(kindLabel('TRADE')).toBe('交易评价')
    expect(viewTargetOf('LISTING')).toBe('商品详情')
    expect(viewTargetOf('TRADE')).toBe('订单详情')
  })

  test('id 唯一（页面拿它当 key）', () => {
    expect(new Set(DEMO_MY_COMMENTS.map((item) => item.id)).size).toBe(DEMO_MY_COMMENTS.length)
  })
})

describe('我的评论 · 演示开关', () => {
  test('两个开关都开 → 演示数据（与「我的」页回退口径同源）', () => {
    expect(demoCommentsEnabled(true, true)).toBe(true)
  })

  test('只开 mock 回退、没开演示登录态 → 不给演示数据（dev:weapp 日常开发不能顶掉真实空态）', () => {
    expect(demoCommentsEnabled(true, false)).toBe(false)
  })

  test('只开演示登录态、没开 mock 回退 → 不给演示数据', () => {
    expect(demoCommentsEnabled(false, true)).toBe(false)
  })

  test('两个都关（生产构建）→ 不给演示数据，页面走 NO_SOURCE_COPY 空态', () => {
    expect(demoCommentsEnabled(false, false)).toBe(false)
  })
})

/**
 * `load.ts` 的**开关接线**（不只是判定体）。
 *
 * 上面四例只覆盖纯函数 `demoCommentsEnabled`；把 `load.ts` 里那行喂参写成
 * `demoCommentsEnabled(MOCK_FALLBACK_ENABLED, MOCK_FALLBACK_ENABLED)`（即只看 mock 回退）
 * 照样能让它们全绿，而这恰好是 `load.ts` 文件头花两段篇幅要防的那件事：
 * `dev:weapp` 的 watch 构建 `__ALLOW_MOCK_FALLBACK__` 为 true、`__DEMO_AUTH__` 为 false，
 * 只认前者就会让演示数据顶掉真实空态。
 *
 * 手法与 `tests/order-list-state.test.ts` 一致：先 `mock.module` 顶掉 Taro，再
 * `Object.assign` 上构建期开关，最后**动态** import（静态 import 会被提升到 mock 之前）。
 *
 * **为什么只测一个组合**：两个开关是 `load.ts` 的**依赖模块**在求值期读的
 * （`features/load-failure`、`features/auth/demo`），而依赖模块在同一个测试进程里只求值
 * 一次。给 `load.ts` 加查询串能拿到新实例、但它的依赖仍是缓存里那份，于是第二、三、四个
 * 组合读到的还是第一次的开关值 —— 那种「绿」是缓存给的，不是接线给的（实测第四个组合
 * 会因此假红）。所以这里只测**唯一真正有判别力的那个组合**：`dev:weapp` 的
 * （mock 回退 true、演示登录 false），它正是上面那条回归。其余组合由纯函数那四例覆盖。
 */
describe('我的评论 · 开关接线（load.ts 真读两个开关）', () => {
  mock.module('@tarojs/taro', () => ({ default: {} }))

  // `dev:weapp`（`taro build --watch` → NODE_ENV=development）的实际注入值
  Object.assign(globalThis, { __ALLOW_MOCK_FALLBACK__: true, __DEMO_AUTH__: false })

  test('dev:weapp 组合（mock 回退开、演示登录关）→ 不给演示数据，页面就是真实空态', async () => {
    const flags = await import('../src/features/load-failure')
    const demoAuth = await import('../src/features/auth/demo')
    // 先确认开关本身确实取到了上面注入的值（否则下面的断言会因为别的原因绿）
    expect(flags.MOCK_FALLBACK_ENABLED).toBe(true)
    expect(demoAuth.DEMO_AUTH_ENABLED).toBe(false)

    const mod = await import('../src/features/comments/load')
    // 只认 mock 回退的实现会在这里得到 true —— 这正是本用例要拦的
    expect(mod.DEMO_COMMENTS_ENABLED).toBe(false)
    expect(await mod.loadMyComments()).toEqual({ items: [], demo: false })
  })
})
