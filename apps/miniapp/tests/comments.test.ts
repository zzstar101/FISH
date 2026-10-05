import { describe, expect, mock, test } from 'bun:test'
import type { MyCommentItem } from '@fish/contracts/comments/schema'
import type { TransactionReviewItem } from '@fish/contracts/transaction-reviews/schema'
import {
  countBySegment,
  DEMO_MY_COMMENTS,
  demoCommentsEnabled,
  emptyStateOf,
  filterBySegment,
  kindLabel,
  kindOfSegment,
  type MyComment,
  ratingChipOf,
  SEGMENTS,
  segmentOf,
  shortCategoryLabel,
  toMyCommentFromCommentItem,
  toMyCommentFromReviewItem,
  viewTargetOf,
} from '../src/features/comments/mine'
import { TRANSACTIONS } from '../src/mock/account'
import { LISTING_BLOCKS } from '../src/mock/blocks'
import { getListing } from '../src/mock/catalog'
import { getUser } from '../src/mock/users'

/**
 * 「我的评论」纯逻辑的回归测试。
 *
 * 锁住的是**口径**而不是渲染（页面接线靠 code review 与端上演示）：
 *
 * 1. **商品留言不给默认评分**（本页最容易做错的一处）：契约里商品留言没有评分字段，
 *    所以 `rating` 恒为 `null`，档位胶囊必须整块不渲染。写死「好评」顶替都是编造 ——
 *    `ratingChipOf` 那组用例锁住这条。
 * 2. **评分是三档不是 1–5 星**（#195 冻结口径）：档位 → 文案/色调的映射按字面量锁。
 * 3. **三段互斥**：全部 = 商品留言 ∪ 交易评价，三个计数必须能互相对上（否则胶囊上的
 *    数字自相矛盾）。真实构建的计数来自服务端 `total`，`countBySegment` 只服务演示构建。
 * 4. **分段 → kind 的换算只在一处**：`kindOfSegment` 的三档与契约
 *    `MyCommentsKindSchema`（all / comment / review）一一对应，写错的话切段会打错请求。
 * 5. **演示数据自洽**：8 条 = 4 条商品留言 + 4 条交易评价，与 1版稿一致。
 *    ⚠️ 这 8 条**不与「我的」页任何数字栏对齐**：`demoProfile()` 里没有评论/评价计数。
 * 6. **演示开关是「与」不是「或」**：`demoCommentsEnabled` 的四种组合。
 *
 * 断言的期望值一律写**字面量**，不回抄实现里的三元表达式 —— 回抄会让「把两个标签
 * 写反」这种错误跟着一起写反、测试照样通过。
 */

/** 适配器用例共用的「现在」：时间文案是相对量，必须共用同一把尺子。
 *  锚在**本地时区**的正午（`setHours`），这样「2 小时前」恒是同一天的 10:00，
 *  断言不依赖跑测试的机器是什么时区。 */
const noon = new Date()
noon.setHours(12, 0, 0, 0)
const NOW_MS = noon.getTime()

function comment(overrides: Partial<MyComment> = {}): MyComment {
  return {
    id: 'C-test',
    kind: 'LISTING',
    category: 'DIGITAL',
    title: '测试商品',
    priceCents: 10000,
    coverUrl: null,
    text: '测试留言',
    timeLabel: '刚刚',
    rating: null,
    to: null,
    targetId: null,
    deleteRef: null,
    ...overrides,
  }
}

describe('我的评论 · 分段口径', () => {
  test('三段互斥：全部 = 商品留言 + 交易评价，三个计数互相能对上', () => {
    const items = [
      comment({ id: 'a' }),
      comment({ id: 'b', kind: 'TRADE', rating: 'POSITIVE', to: '某人' }),
      comment({ id: 'c', kind: 'TRADE', rating: 'NEUTRAL', to: '另一个人' }),
    ]

    // 具体值断言（不回抄实现）：1 条留言 + 2 条评价 = 3 条
    expect(countBySegment(items)).toEqual({ all: 3, listing: 1, trade: 2 })
  })

  test('分段过滤：选「全部」不筛，选具体段只留那一段', () => {
    const items = [
      comment({ id: 'a' }),
      comment({ id: 'b', kind: 'TRADE', rating: 'POSITIVE', to: '某人' }),
    ]

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

  test('分段 → /me/comments 的 kind 档位（字面量，写错会打错请求）', () => {
    expect(kindOfSegment('all')).toBe('all')
    expect(kindOfSegment('listing')).toBe('comment')
    expect(kindOfSegment('trade')).toBe('review')
  })
})

describe('我的评论 · 三档评分', () => {
  test('评分是 null（商品留言）时不给胶囊 —— 不是「好评」也不是默认满分', () => {
    expect(ratingChipOf(null)).toBeNull()
  })

  test('三档各自的文案与色调类（字面量，不回抄实现的映射表）', () => {
    expect(ratingChipOf('POSITIVE')).toEqual({ label: '好评', cls: 'is-pos' })
    expect(ratingChipOf('NEUTRAL')).toEqual({ label: '中评', cls: 'is-mid' })
    expect(ratingChipOf('NEGATIVE')).toEqual({ label: '差评', cls: 'is-neg' })
  })
})

describe('我的评论 · 真实数据适配器', () => {
  /**
   * 适配器的输入按契约类型构造（api 层已用 schema 收口，这里不重复 zod.parse）。
   * 字段只列适配器**读得到**的部分；其余按类型补齐为中性值。
   */
  const listingCard = {
    id: 'l_01',
    title: '米家 LED 护眼台灯 可调色温',
    priceCents: 4500,
    category: 'DAILY',
    condition: 'LIKE_NEW',
    status: 'ACTIVE',
    urgent: false,
    negotiable: true,
    free: false,
    coverUrl: 'https://cdn.example.com/cover.jpg',
    createdAt: '2026-09-01T10:00:00+08:00',
  } as const

  const commentItem = {
    comment: {
      id: 'cmt_01',
      listingId: 'l_01',
      parentId: null,
      content: '还在吗？我今晚下课顺路',
      // NOW（本地正午）往前 2 小时 = 本地 10:00，同一自然日
      createdAt: new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString(),
    },
    listing: listingCard,
  } as MyCommentItem

  const reviewItem = {
    review: {
      id: 'rvw_01',
      transactionId: 'tx_01',
      rating: 'NEGATIVE',
      body: null,
      images: [],
      createdAt: '2026-10-03T18:00:00+08:00',
    },
    transaction: {
      id: 'tx_01',
      conversationId: 'cnv_01',
      listingId: 'l_01',
      buyerId: 'usr_a',
      sellerId: 'usr_b',
      role: 'buyer',
      listing: {
        id: 'l_01',
        title: '米家 LED 护眼台灯 可调色温',
        priceCents: 4500,
        status: 'SOLD',
        coverUrl: null,
      },
      counterpart: { id: 'usr_b', nickname: '周予安', avatarUrl: null },
      amountCents: 4000,
      status: 'COMPLETED',
      buyerConfirmedAt: null,
      sellerConfirmedAt: null,
      completedAt: '2026-10-02T12:00:00+08:00',
      cancelledAt: null,
      createdAt: '2026-10-01T12:00:00+08:00',
      updatedAt: '2026-10-02T12:00:00+08:00',
    },
  } as unknown as TransactionReviewItem

  test('留言行：跳商品、删评论、没有评分与对方', () => {
    const row = toMyCommentFromCommentItem(commentItem, NOW_MS)
    expect(row.kind).toBe('LISTING')
    expect(row.targetId).toBe('l_01')
    expect(row.deleteRef).toEqual({ type: 'comment', commentId: 'cmt_01' })
    expect(row.rating).toBeNull()
    expect(row.to).toBeNull()
    expect(row.text).toBe('还在吗？我今晚下课顺路')
    expect(row.coverUrl).toBe('https://cdn.example.com/cover.jpg')
    // 时间走 dayLabelOf：10:00 → 「今天 10:00」（NOW 是 12:00，同一天）
    expect(row.timeLabel).toBe('今天 10:00')
  })

  test('评价行：跳订单、删评价边、成交价不是挂价、空评语是空串', () => {
    const row = toMyCommentFromReviewItem(reviewItem, NOW_MS)
    expect(row.kind).toBe('TRADE')
    expect(row.targetId).toBe('tx_01')
    expect(row.deleteRef).toEqual({ type: 'review', transactionId: 'tx_01' })
    expect(row.rating).toBe('NEGATIVE')
    expect(row.to).toBe('周予安')
    // 展示的是成交价 amountCents（4000），不是商品挂价（4500）
    expect(row.priceCents).toBe(4000)
    // body 为 null（只打分没写字）→ 空串，页面整行不渲染文本
    expect(row.text).toBe('')
    // 交易内嵌的商品摘要没有分类字段 → null，页面退回 OTHER 色块、不画品类小字
    expect(row.category).toBeNull()
  })
})

describe('我的评论 · 演示数据自洽', () => {
  test('8 条 = 4 条商品留言 + 4 条交易评价（与稿一致）', () => {
    expect(DEMO_MY_COMMENTS).toHaveLength(8)
    expect(countBySegment(DEMO_MY_COMMENTS)).toEqual({ all: 8, listing: 4, trade: 4 })
  })

  test('评分与评价对象只出现在交易评价上，商品留言一律为 null', () => {
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

  test('演示评分是三档枚举值（不是 1–5 的数字）', () => {
    for (const item of DEMO_MY_COMMENTS) {
      if (item.rating === null) continue
      expect(['POSITIVE', 'NEUTRAL', 'NEGATIVE']).toContain(item.rating)
      // 每一档都能给出胶囊（档位映射表没有漏值）
      expect(ratingChipOf(item.rating)).not.toBeNull()
    }
  })

  test('每条都能画出来：色块分类、两字品类、标题/正文/时间都有值', () => {
    for (const item of DEMO_MY_COMMENTS) {
      // 色块：页面的 `blockOf` 拿 `LISTING_BLOCKS[category][0]`，缺键会静默退回 OTHER ——
      // 那会让这一条显示成「其他」的灰块，而品类小字仍写着真分类，自相矛盾。
      expect(LISTING_BLOCKS[item.category as NonNullable<MyComment['category']>]?.[0]).toBeString()
      expect(shortCategoryLabel(item.category as NonNullable<MyComment['category']>)).toHaveLength(
        2,
      )
      expect(item.title.length).toBeGreaterThan(0)
      expect(item.text.length).toBeGreaterThan(0)
      expect(item.timeLabel.length).toBeGreaterThan(0)
    }
  })

  /**
   * 交易评价的时间必须是**面交完成之后**才有的事。
   *
   * 稿子里这两行写的是 5 月，而它们引用的成交在 8 月 —— 照抄会显示成「面交前两个月
   * 就评价了」。这里**从 `TRANSACTIONS` 的 `completedAt` 反推**，不写死字符串：
   * 写死的话，把 t-104 的完成时间挪到 9 月，本用例照样绿、页面上却已经自相矛盾。
   */
  test('两条真实成交的评价时间不早于成交日期（订单页「已于 …」的日期）', () => {
    const toMonthDay = (iso: string): { month: number; day: number } => {
      const at = new Date(iso)
      return { month: at.getMonth() + 1, day: at.getDate() }
    }

    for (const [txId, commentId] of [
      ['t-104', 'C05'],
      ['t-106', 'C06'],
    ] as const) {
      const tx = TRANSACTIONS.find((row) => row.id === txId)
      expect(tx?.status).toBe('COMPLETED')
      // 契约保证 COMPLETED 必带 completedAt（订单页「已于 …」就是它）
      expect(tx?.completedAt).toBeString()
      const settled = toMonthDay(tx?.completedAt as string)

      const item = DEMO_MY_COMMENTS.find((row) => row.id === commentId)
      const parsed = /^(\d+) 月 (\d+) 日$/.exec(item?.timeLabel ?? '')
      expect(parsed).not.toBeNull()

      const [, month, day] = parsed as RegExpExecArray
      // 同月同日也允许（当天面交、当场评价）；早于成交日就是错的
      expect(Number(month)).toBe(settled.month)
      expect(Number(day)).toBeGreaterThanOrEqual(settled.day)
    }
  })

  /**
   * 演示行的「对方」与「商品标题」必须与 fixture 里的真实归属对得上。
   * 这里**从 fixture 反查**，而不是回抄本模块的字面量 —— 只回抄的话，fixture 改了名这里照样绿。
   */
  test('对方 = 该商品在 fixture 里的卖家；标题 = 该商品在 fixture 里的标题', () => {
    const titled = (title: string) => DEMO_MY_COMMENTS.find((item) => item.title === title)

    // C07《灌篮高手》的卖家
    const comic = titled('灌篮高手 完全版 1-24 全集')
    expect(comic?.to).toBe(getUser('u-chengzi').nickname)
    // C08 兰蔻的卖家
    const serum = titled('兰蔻小黑瓶精华 50ml 全新未拆')
    expect(serum?.to).toBe(getUser('u-soda').nickname)

    // C05 / C06 引用的成交：标题与对方都从 TRANSACTIONS 反查
    for (const [txId, commentId] of [
      ['t-104', 'C05'],
      ['t-106', 'C06'],
    ] as const) {
      const tx = TRANSACTIONS.find((row) => row.id === txId)
      expect(tx).toBeDefined()
      const listing = tx ? getListing(tx.listingId) : undefined
      expect(listing).toBeDefined()
      const item = DEMO_MY_COMMENTS.find((row) => row.id === commentId)
      expect(item?.title).toBe(listing?.title)
      expect(item?.to).toBe(tx ? getUser(tx.counterpartId).nickname : undefined)
    }
  })

  test('演示行不带跳转/删除目标（真实 id 在库里不存在，动作只能给说明 toast）', () => {
    for (const item of DEMO_MY_COMMENTS) {
      expect(item.targetId).toBeNull()
      expect(item.deleteRef).toBeNull()
      expect(item.coverUrl).toBeNull()
    }
  })

  test('类型胶囊与「查看…」按钮的文案（字面量，不回抄实现的三元表达式）', () => {
    expect(kindLabel('LISTING')).toBe('商品留言')
    expect(kindLabel('TRADE')).toBe('交易评价')
    expect(viewTargetOf('LISTING')).toBe('商品详情')
    expect(viewTargetOf('TRADE')).toBe('订单详情')
  })

  test('id 唯一（页面拿它当 key）', () => {
    expect(new Set(DEMO_MY_COMMENTS.map((item) => item.id)).size).toBe(DEMO_MY_COMMENTS.length)
  })
})

describe('我的评论 · 空态文案', () => {
  /**
   * 三支分段空态，演示构建与真实构建共用（真实数据下分段空了就是真的没有）。
   * 都写字面量期望值（不回抄实现），这样「把商品留言与交易评价两支写反」才会失败。
   */
  test('商品留言段与交易评价段的空态不互换', () => {
    expect(emptyStateOf('listing').title).toBe('没有发过商品留言')
    expect(emptyStateOf('listing').action).toBe('看全部评论')
    expect(emptyStateOf('trade').title).toBe('还没有交易评价')
    expect(emptyStateOf('trade').action).toBe('看全部评论')
  })

  test('「全部」段是「去逛逛」（还没有任何评论），不是「看全部评论」', () => {
    expect(emptyStateOf('all').title).toBe('还没有发过评论')
    expect(emptyStateOf('all').action).toBe('去逛逛')
  })
})

describe('我的评论 · 演示开关', () => {
  test('两个开关都开 → 演示数据（与「我的」页回退口径同源）', () => {
    expect(demoCommentsEnabled(true, true)).toBe(true)
  })

  test('只开 mock 回退、没开演示登录态 → 不给演示数据（缺一不可，真实接口优先）', () => {
    expect(demoCommentsEnabled(true, false)).toBe(false)
  })

  test('只开演示登录态、没开 mock 回退 → 不给演示数据', () => {
    expect(demoCommentsEnabled(false, true)).toBe(false)
  })

  test('两个都关（生产构建）→ 不给演示数据，页面走真实接口', () => {
    expect(demoCommentsEnabled(false, false)).toBe(false)
  })
})

/**
 * `load.ts` 的**开关接线**（不只是判定体）。
 *
 * 上面四例只覆盖纯函数 `demoCommentsEnabled`；把 `load.ts` 里那行喂参写成
 * `demoCommentsEnabled(MOCK_FALLBACK_ENABLED, MOCK_FALLBACK_ENABLED)`（即只看 mock 回退）
 * 照样能让它们全绿，而这恰好是 `load.ts` 文件头花两段篇幅要防的那件事：
 * 只认 `__ALLOW_MOCK_FALLBACK__`（`__DEMO_AUTH__` 关）时，演示数据会顶掉真实接口。
 *
 * 手法与 `tests/order-list-state.test.ts` 一致：先 `mock.module` 顶掉 Taro，再
 * `Object.assign` 上构建期开关，最后**动态** import（静态 import 会被提升到 mock 之前）。
 *
 * **为什么只测一个组合**：两个开关是 `load.ts` 的**依赖模块**在求值期读的，
 * 依赖模块在同一个测试进程里只求值一次（详见该文件在 #196 时代的完整论证）。
 * 这里只测**唯一真正有判别力的那个组合**（mock 回退 true、演示登录 false，
 * 两个注入点分开时可能出现），它正是上面那条回归。其余组合由纯函数那四例覆盖。
 */
describe('我的评论 · 开关接线（load.ts 真读两个开关）', () => {
  mock.module('@tarojs/taro', () => ({ default: {} }))

  // 兜底开、演示登录关（#304 起 `dev:weapp` 不再产生这个组合；两个注入点分开时仍可能出现）
  Object.assign(globalThis, { __ALLOW_MOCK_FALLBACK__: true, __DEMO_AUTH__: false })

  test('兜底开 / 演示登录关 → 不给演示数据，页面走真实接口', async () => {
    const flags = await import('../src/features/load-failure')
    const demoAuth = await import('../src/features/auth/demo')
    // 先确认开关本身确实取到了上面注入的值（否则下面的断言会因为别的原因绿）
    expect(flags.MOCK_FALLBACK_ENABLED).toBe(true)
    expect(demoAuth.DEMO_AUTH_ENABLED).toBe(false)

    const mod = await import('../src/features/comments/load')
    // 只认 mock 回退的实现会在这里得到 true —— 这正是本用例要拦的
    expect(mod.DEMO_COMMENTS_ENABLED).toBe(false)
  })
})
