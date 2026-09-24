import { describe, expect, test } from 'bun:test'
import {
  cardLabel,
  countBySegment,
  emptyText,
  emptyTitle,
  lockNote,
  segmentLabel,
  segmentOf,
} from '../src/pages/mylist/list'

/**
 * 「我的发布」分档判定（#74 / #89 mylist 行真实接线）。
 * 组件接线没有单测（本仓 tests/ 只有纯逻辑测试，无 Taro 组件渲染基建）。
 *
 * 两组最容易做错的边界：
 *
 * 1. **审核态不参与分档**（Owner 拍板：这一页不需要审核中的概念）：`moderationStatus` 一律不读，
 *    卡在审核里的商品（库里同样是 `status = OFFLINE`）与「自己下架的」一起读作「已下架」。
 * 2. **「待确认」有两个来源**：`RESERVED`（卖家已同意、待面交），以及**商品仍是 `ACTIVE`
 *    但有买家在等**（`awaiting`，会话侧推导后传进来）。只看 `status` 的话，一件买家点了
 *    「我想要」的商品会显示成「在售」，卖家根本看不出有人在等。
 */

type Card = Parameters<typeof segmentOf>[0]

const card = (over: Partial<Card> = {}): Card => ({
  id: 'L1',
  status: 'ACTIVE',
  ...over,
})

describe('segmentOf —— 只看商品状态', () => {
  test('ACTIVE 无人在等 → 在售；RESERVED → 待确认；SOLD → 已售出；OFFLINE → 已下架', () => {
    expect(segmentOf(card(), false)).toBe('sale')
    expect(segmentOf(card({ status: 'RESERVED' }), false)).toBe('pending')
    expect(segmentOf(card({ status: 'SOLD' }), false)).toBe('sold')
    expect(segmentOf(card({ status: 'OFFLINE' }), false)).toBe('off')
  })
})

describe('segmentOf —— 有买家在等（awaiting）时进「待确认」', () => {
  test('在售 + 有买家在等 → 待确认；没有在等 → 在售', () => {
    expect(segmentOf(card(), true)).toBe('pending')
    expect(segmentOf(card(), false)).toBe('sale')
  })

  test('awaiting 只对 ACTIVE 起作用：已下架 / 已售出不因它换段', () => {
    // 一件自己下架的商品上挂着未回应的申请，读到的仍是「已下架」——
    // 换段会让分段计数与列表对不上
    expect(segmentOf(card({ status: 'OFFLINE' }), true)).toBe('off')
    expect(segmentOf(card({ status: 'SOLD' }), true)).toBe('sold')
  })

  test('RESERVED 无论如何都在「待确认」（已同意、待面交）', () => {
    expect(segmentOf(card({ status: 'RESERVED' }), true)).toBe('pending')
  })
})

describe('countBySegment —— 分段计数', () => {
  test('四种状态各计一段', () => {
    const counts = countBySegment([
      card(),
      card({ status: 'RESERVED' }),
      card({ status: 'OFFLINE' }),
      card({ status: 'OFFLINE' }),
      card({ status: 'SOLD' }),
    ])
    expect(counts).toEqual({ sale: 1, pending: 1, sold: 1, off: 2 })
  })

  test('awaiting 集合把在售的卡片挪进「待确认」，总数守恒', () => {
    const cards = [card({ id: 'a' }), card({ id: 'b' }), card({ id: 'c', status: 'SOLD' })]
    const counts = countBySegment(cards, new Set(['a']))
    expect(counts).toEqual({ sale: 1, pending: 1, sold: 1, off: 0 })
    expect(Object.values(counts).reduce((sum, n) => sum + n, 0)).toBe(cards.length)
  })
})

describe('segmentLabel —— 胶囊文案就是分段名', () => {
  test('四段各自的名字', () => {
    expect(segmentLabel('sale')).toBe('在售')
    expect(segmentLabel('pending')).toBe('待确认')
    expect(segmentLabel('sold')).toBe('已售出')
    expect(segmentLabel('off')).toBe('已下架')
  })
})

describe('cardLabel —— 「待确认」段里的两种子状态要分开说', () => {
  test('有买家在等 → 待确认；已同意待面交 → 待面交', () => {
    /*
     * 这两种子状态在同一段里，但卡片正文一个写「谁点了我想要」、另一个写「已同意 · 等面交」。
     * 胶囊如果都顶「待确认」，后者的卡面就自相矛盾（同一张卡既说待确认又说已同意）。
     */
    expect(cardLabel('pending', true)).toBe('待确认')
    expect(cardLabel('pending', false)).toBe('待面交')
  })

  test('其余三段与分段名一致（awaiting 不影响它们）', () => {
    expect(cardLabel('sale', false)).toBe('在售')
    expect(cardLabel('sold', false)).toBe('已售出')
    expect(cardLabel('off', false)).toBe('已下架')
    expect(cardLabel('sale', true)).toBe('在售')
  })
})

describe('lockNote —— 只有「已售出」挂锁定说明', () => {
  test('已售出给说明，待确认不给', () => {
    expect(lockNote('sold')).not.toBe('')
    // 待确认的「先别改」由「谁在等」那行 + 决策按钮表达，挂锁图标会跟旁边的按钮打架（稿 ⑥）
    expect(lockNote('pending')).toBe('')
    expect(lockNote('off')).toBe('')
  })
})

describe('emptyTitle / emptyText —— 空态说明该段会出现什么', () => {
  test('各段的标题互不相同，不复用同一句', () => {
    const titles = (['sale', 'pending', 'sold', 'off'] as const).map(emptyTitle)
    expect(new Set(titles).size).toBe(titles.length)
  })

  test('待确认为空时说清「买家点了我想要才会来」', () => {
    expect(emptyText('pending')).toContain('我想要')
  })

  test('已下架的空态说清「可以重新上架」', () => {
    expect(emptyText('off')).toContain('重新上架')
  })
})
