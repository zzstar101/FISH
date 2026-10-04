import { describe, expect, test } from 'bun:test'
import type { MyCommentItem } from '@fish/contracts/comments/schema'
import type { TransactionReviewItem } from '@fish/contracts/transaction-reviews/schema'
import type { ViewHistoryItem } from '@fish/contracts/view-history/schema'
import {
  applyCleared,
  canClear,
  clearBlockedOf,
  clearDoneOf,
  clearedOf,
  DEMO_FAVS,
  DEMO_HISTORY,
  DEMO_MESSAGES,
  type DemoRecords,
  emptyCopyOf,
  emptyKindOf,
  favoriteCell,
  goneLabelOf,
  groupByDay,
  messageRow,
  NOTHING_CLEARED,
  noteOf,
  TAB_KEYS,
  TABS,
  tailTextOf,
  viewHistoryCell,
  withCleared,
} from '../src/pages/history/records'

/**
 * 「历史浏览」的数据口径（#415/#190/#195 接线后：真实构建三档读真接口，见 records.ts 文件头）。
 * 组件接线没有单测（本仓 tests/ 只有纯逻辑测试，无 Taro 组件渲染基建）。
 *
 * 这里锁的是几件最容易做错的事：
 * 1. 失效角标在「全部浏览」与「我收藏的」两处一致（同一件商品不能一处说已下架、
 *    另一处还能买）；真实适配器的失效判据与演示 fixture 同源（`goneLabelOf`）；
 * 2. 空态两种来由**不能混成一句**：「还没有记录」与「已清空」——
 *    混了就会出现「我明明清空的，怎么说是没有记录」；
 * 3. 清空是**真的清**（演示构建）、只清当前档、刷新之后仍然是空的；
 *    真实构建只有浏览档有批量写端点（`canClear` 的档位判据）；
 * 4. 「清空过」是**账号作用域**的：换账号不能带着上一个账号的记忆。
 * 5. **真实数据适配器**：足迹/收藏的失效口径、留言行的跳转目标（留言 → 商品、
 *    评价 → 交易）、评价行没有分类字段（null，不是编一个「其他」）。
 *
 * ⚠️ **「演示条数与『我的』页数字栏对齐」这条约束不在本文件**：
 * 那个数字的真源是 `features/fetchers.ts` 的 `demoProfile()`（收藏 8 / 足迹 24），
 * 它没有 export 且本轮白名单不允许改那个文件，所以这里只能锁「演示 fixture 自己的
 * 形状」（4 天 × 6 件 = 24 / 收藏 8 / 留言 8）—— 把 `demoProfile().historyCount`
 * 改成别的值，下面的用例**仍然会全绿**。真正的对齐靠改动两侧时人工比对，
 * 这里如实说明，不假装锁住了。
 */
describe('演示数据的形状（见文件头：与「我的」页的对齐不在这里锁）', () => {
  test('足迹 24 件 · 4 天', () => {
    expect(DEMO_HISTORY).toHaveLength(4)
    const total = DEMO_HISTORY.reduce((n, day) => n + day.items.length, 0)
    expect(total).toBe(24)
    for (const day of DEMO_HISTORY) expect(day.items).toHaveLength(6)
  })

  test('收藏 8 件 / 留言 8 条（4 条商品留言 + 4 条交易评价）', () => {
    expect(DEMO_FAVS).toHaveLength(8)
    expect(DEMO_MESSAGES).toHaveLength(8)
    expect(DEMO_MESSAGES.filter((item) => item.kind === 'comment')).toHaveLength(4)
    expect(DEMO_MESSAGES.filter((item) => item.kind === 'review')).toHaveLength(4)
  })

  test('id 唯一：列表 key 不会撞', () => {
    const ids = [
      ...DEMO_HISTORY.flatMap((day) => day.items.map((item) => item.id)),
      ...DEMO_FAVS.map((item) => item.id),
      ...DEMO_MESSAGES.map((item) => item.id),
    ]
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('失效角标：两处口径一致', () => {
  test('同一件商品在足迹与收藏里的失效判据相同', () => {
    const goneOf = (items: { title: string; gone: string | null }[]) =>
      new Map(items.map((item) => [item.title, item.gone]))
    const history = goneOf(DEMO_HISTORY.flatMap((day) => day.items))
    const favs = goneOf(DEMO_FAVS)

    let shared = 0
    for (const [title, gone] of favs) {
      if (!history.has(title)) continue
      shared += 1
      expect(gone).toBe(history.get(title))
    }
    // 两处至少要有若干件重叠，否则这条断言等于没测（稿里两档就是同一份商品）
    expect(shared).toBeGreaterThanOrEqual(6)
  })

  test('角标只有「已下架 / 已卖掉」两种取值', () => {
    const all = [...DEMO_HISTORY.flatMap((day) => day.items), ...DEMO_FAVS].map((item) => item.gone)
    for (const gone of all) expect([null, '已下架', '已卖掉']).toContain(gone)
    // 「已降价」角标按 Owner 决策④删掉了，不要加回来。
    // 注：这条在类型层面是恒真的（`GoneLabel` 只有两个值），留着是为了让
    // 「谁把角标加回来」在 diff 里一眼可见 —— 它更像一条警示，不是一道有效的防线。
    expect(all).not.toContain('已降价')
  })
})

describe('清空：演示构建下是真的清，真实构建下只给说明', () => {
  const records = (ownerId: string): DemoRecords => ({
    ownerId,
    days: DEMO_HISTORY,
    favs: DEMO_FAVS,
    msgs: DEMO_MESSAGES,
  })

  test('演示构建三档都能清；真实构建只有浏览档能清（收藏/留言没有批量端点）', () => {
    // 这一条锁的是 `canClear` 的**入参口径**（页面必须传 `demo` 与当前档，不能传常量）。
    // 页面有没有真的把两个值传进来，单测覆盖不到 —— 那要靠 code review。
    for (const tab of TAB_KEYS) expect(canClear(true, tab)).toBe(true)
    expect(canClear(false, 'history')).toBe(true)
    expect(canClear(false, 'favs')).toBe(false)
    expect(canClear(false, 'msgs')).toBe(false)
  })

  test('清掉某一档之后，那一档真的空了，另外两档不受影响', () => {
    const cleared = clearedOf(
      withCleared({ ...NOTHING_CLEARED, ownerId: 'u-1' }, 'u-1', 'favs'),
      'u-1',
    )
    expect(cleared).toEqual({ history: false, favs: true, msgs: false })

    const after = applyCleared(records('u-1'), cleared)
    expect(after.favs).toHaveLength(0)
    // 另外两档必须原样保留 —— 清一档顺手清掉别的档是最坏的一种错
    expect(after.days).toBe(DEMO_HISTORY)
    expect(after.msgs).toBe(DEMO_MESSAGES)
  })

  test('三档都能各自清掉，且**刷新之后仍然是空的**（数据源没被改回去）', () => {
    let state = { ...NOTHING_CLEARED, ownerId: 'u-1' }
    for (const tab of TAB_KEYS) state = withCleared(state, 'u-1', tab)

    // 「刷新」= 重新取一次同样的演示数据，再按清空标记过滤
    const after = applyCleared(records('u-1'), clearedOf(state, 'u-1'))
    expect(after.days).toHaveLength(0)
    expect(after.favs).toHaveLength(0)
    expect(after.msgs).toHaveLength(0)
    // 底层 fixture 不能被就地改掉：`applyCleared` 是纯函数，原数组长度不变
    expect(DEMO_HISTORY).toHaveLength(4)
    expect(DEMO_FAVS).toHaveLength(8)
    expect(DEMO_MESSAGES).toHaveLength(8)
  })

  test('没清过时是恒等变换（连引用都不换，省一次渲染）', () => {
    const source = records('u-1')
    expect(applyCleared(source, NOTHING_CLEARED)).toBe(source)
  })

  test('「清空过」是账号作用域的：换账号 / 未登录一律按没清过读', () => {
    const cleared = withCleared({ ...NOTHING_CLEARED, ownerId: 'u-1' }, 'u-1', 'history')
    // 同一个账号：记得
    expect(clearedOf(cleared, 'u-1').history).toBe(true)
    // 换了账号：上一个账号的记忆必须作废，否则新账号一进来就看到空列表
    expect(clearedOf(cleared, 'u-2')).toEqual(NOTHING_CLEARED)
    // 退出登录：同上
    expect(clearedOf(cleared, null)).toEqual(NOTHING_CLEARED)
  })

  test('清空成功与做不了的说明各说各的，且带上这一档的记录名', () => {
    expect(clearDoneOf('history')).toBe('已清空浏览记录')
    expect(clearDoneOf('favs')).toBe('已清空收藏')
    expect(clearDoneOf('msgs')).toBe('已清空留言')

    // 做不了的说明要包含「清空」二字（兜底路径；真实构建下按钮在该档直接隐藏）
    for (const tab of TAB_KEYS) {
      const text = clearBlockedOf(tab)
      expect(text).toContain('清空')
    }
  })
})

describe('三档的文案', () => {
  test('tab 顺序与键：全部浏览 / 我收藏的 / 我留言的', () => {
    expect(TABS.map((item) => item.key)).toEqual([...TAB_KEYS])
    expect(TABS.map((item) => item.label)).toEqual(['全部浏览', '我收藏的', '我留言的'])
  })

  test('到底提示按档位给量词', () => {
    expect(tailTextOf('history', 24)).toBe('已显示全部 24 件')
    expect(tailTextOf('favs', 8)).toBe('已显示全部 8 件')
    expect(tailTextOf('msgs', 8)).toBe('已显示全部 8 条')
  })

  test('只有浏览档有底部说明（收藏档的「已降价」说明随角标一起去掉）', () => {
    expect(noteOf('history')).toBe('浏览记录只保留最近 30 天，更早的会自动清掉。')
    expect(noteOf('favs')).toBe('')
    expect(noteOf('msgs')).toBe('')
  })
})

describe('空态：两种来由不能混成一句', () => {
  test('来由判定：清过 > 本来就没有（#415/#190/#195 后真实构建空了就是真的没有）', () => {
    expect(emptyKindOf(false)).toBe('empty')
    expect(emptyKindOf(true)).toBe('cleared')
  })

  test('「empty」空态说「还没有」，不提后端（缺口说明那三支已随接线删除）', () => {
    for (const tab of TAB_KEYS) {
      const copy = emptyCopyOf(tab, 'empty')
      expect(copy.title).not.toContain('后端')
      expect(copy.title).toContain('还没有')
      expect(copy.action).toBe('去逛逛')
    }
  })

  test('清空之后的空态说「已清空」，与「还没有」区分开', () => {
    for (const tab of TAB_KEYS) {
      const cleared = emptyCopyOf(tab, 'cleared')
      const empty = emptyCopyOf(tab, 'empty')
      expect(cleared.title).toContain('已清空')
      // 两者互不相同：同一句话套两种来由，用户会以为清空没生效
      expect(cleared.title).not.toBe(empty.title)
      expect(cleared.text).not.toBe(empty.text)
    }
  })
})

describe('真实数据适配器（#415/#190/#195 接线）', () => {
  /** 「现在」锚在本地正午，日期断言不依赖跑测试的机器时区（与 comments.test.ts 同一手法） */
  const noon = new Date()
  noon.setHours(12, 0, 0, 0)
  const NOW_MS = noon.getTime()
  const isoAgo = (ms: number) => new Date(NOW_MS - ms).toISOString()

  const listingBase = {
    id: 'l_01',
    title: '测试商品',
    priceCents: 4500,
    category: 'DAILY',
    condition: 'LIKE_NEW',
    status: 'ACTIVE',
    urgent: false,
    negotiable: true,
    free: false,
    coverUrl: null,
    createdAt: '2026-09-01T10:00:00+08:00',
  } as const

  test('失效角标：OFFLINE=已下架、SOLD=已卖掉、在售没有角标', () => {
    expect(goneLabelOf('OFFLINE')).toBe('已下架')
    expect(goneLabelOf('SOLD')).toBe('已卖掉')
    expect(goneLabelOf('ACTIVE')).toBeNull()
  })

  test('足迹 / 收藏行：id、价格、失效角标来自商品卡', () => {
    const viewItem = {
      listing: { ...listingBase, status: 'SOLD' },
      viewedAt: new Date(NOW_MS - 60 * 60 * 1000).toISOString(),
    } as ViewHistoryItem
    const cell = viewHistoryCell(viewItem)
    expect(cell.id).toBe('l_01')
    expect(cell.gone).toBe('已卖掉')
    expect(cell.priceCents).toBe(4500)

    const favItem = { listing: listingBase, favoritedAt: isoAgo(60 * 60 * 1000) }
    expect(favoriteCell(favItem as never).gone).toBeNull()
  })

  test('留言行：商品留言跳商品、评价行跳交易且没有分类字段', () => {
    const commentItem = {
      comment: {
        id: 'cmt_01',
        listingId: 'l_01',
        parentId: null,
        content: '还在吗',
        createdAt: isoAgo(30 * 60 * 1000),
      },
      listing: listingBase,
    } as MyCommentItem
    const commentRow = messageRow(commentItem, NOW_MS)
    expect(commentRow.kind).toBe('comment')
    expect(commentRow.target).toEqual({ kind: 'listing', id: 'l_01' })
    expect(commentRow.category).toBe('DAILY')

    const reviewItem = {
      review: {
        id: 'rvw_01',
        transactionId: 'tx_01',
        rating: 'POSITIVE',
        body: null,
        images: [],
        createdAt: isoAgo(90 * 60 * 1000),
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
          title: '测试商品',
          priceCents: 4500,
          status: 'SOLD',
          coverUrl: null,
        },
        counterpart: { id: 'usr_b', nickname: '对方', avatarUrl: null },
        amountCents: 4000,
        status: 'COMPLETED',
        buyerConfirmedAt: null,
        sellerConfirmedAt: null,
        completedAt: null,
        cancelledAt: null,
        createdAt: isoAgo(90 * 60 * 1000),
        updatedAt: isoAgo(90 * 60 * 1000),
      },
    } as unknown as TransactionReviewItem
    const reviewRow = messageRow(reviewItem, NOW_MS)
    expect(reviewRow.kind).toBe('review')
    // 评价行的跳转目标是那笔交易（面交/订单页），不是商品
    expect(reviewRow.target).toEqual({ kind: 'transaction', id: 'tx_01' })
    // 交易内嵌商品摘要没有分类字段：null（不是编一个「其他」）
    expect(reviewRow.category).toBeNull()
    // 只打分没写字 → 空串，页面整行不渲染文本
    expect(reviewRow.text).toBe('')
  })

  test('按浏览日分组：同日合组、组内保持服务端顺序、标签是 今天/昨天/M 月 D 日', () => {
    const cell = (id: string) => ({
      id,
      category: 'DAILY' as const,
      title: id,
      priceCents: 100,
      gone: null,
    })
    const rows = [
      { ...cell('a'), viewedAt: isoAgo(1 * 60 * 60 * 1000) },
      { ...cell('b'), viewedAt: isoAgo(2 * 60 * 60 * 1000) },
      { ...cell('c'), viewedAt: isoAgo(26 * 60 * 60 * 1000) },
      { ...cell('d'), viewedAt: isoAgo(50 * 24 * 60 * 60 * 1000) },
    ]
    const days = groupByDay(rows, NOW_MS)
    expect(days).toHaveLength(3)
    // 组内顺序 = 服务端顺序（最近的在前）
    expect(days[0]?.items.map((item) => item.id)).toEqual(['a', 'b'])
    expect(days[0]?.date).toBe('今天')
    expect(days[1]?.date).toBe('昨天')
    // 更早的按本地日期给「M 月 D 日」（不写死月份，时区无关）
    expect(days[2]?.date).toMatch(/^\d+ 月 \d+ 日$/)
  })
})
