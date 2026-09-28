import { describe, expect, test } from 'bun:test'
import {
  cardLabel,
  countBySegment,
  emptyText,
  emptyTitle,
  lockNote,
  pillClassOf,
  SEGMENTS,
  segmentLabel,
  segmentOf,
} from '../src/pages/mylist/list'

/**
 * 「我的发布」分档判定（#74 / #89 mylist 行真实接线；「审核」段见 Owner 2026-09-28 拍板）。
 * 组件接线没有单测（本仓 tests/ 只有纯逻辑测试，无 Taro 组件渲染基线）。
 *
 * 三组最容易做错的边界：
 *
 * 1. **「审核」段要同时读 `status` 与 `moderationStatus`**：审核中（`REVIEW`）与不过审
 *    （`BLOCKED`）在库里都是 `status = OFFLINE`，只看 `status` 会把它们跟「自己下架的」
 *    混成一段，两种子状态的动作（等结论 vs 编辑/删除）也就无从区分。
 * 2. **`moderationStatus = null` 的历史行仍读作「已下架」**：`null` 是加审核列之前的老数据，
 *    不是「审核中」。
 * 3. **「待确认」有两个来源**：`RESERVED`（卖家已同意、待面交），以及**商品仍是 `ACTIVE`
 *    但有买家在等**（`awaiting`，会话侧推导后传进来）。只看 `status` 的话，一件买家点了
 *    「我想要」的商品会显示成「在售」，卖家根本看不出有人在等。
 */

type Card = Parameters<typeof segmentOf>[0]

const card = (over: Partial<Card> = {}): Card => ({
  id: 'L1',
  status: 'ACTIVE',
  moderationStatus: 'APPROVED',
  ...over,
})

describe('segmentOf —— 状态 + 审核态一起决定分段', () => {
  test('ACTIVE 无人在等 → 在售；RESERVED → 待确认；SOLD → 已售出', () => {
    expect(segmentOf(card(), false)).toBe('sale')
    expect(segmentOf(card({ status: 'RESERVED' }), false)).toBe('pending')
    expect(segmentOf(card({ status: 'SOLD' }), false)).toBe('sold')
  })

  test('OFFLINE 里审核中 / 不过审自成一档，自己下架的仍在「已下架」', () => {
    expect(segmentOf(card({ status: 'OFFLINE', moderationStatus: 'REVIEW' }), false)).toBe('review')
    expect(segmentOf(card({ status: 'OFFLINE', moderationStatus: 'BLOCKED' }), false)).toBe(
      'review',
    )
    expect(segmentOf(card({ status: 'OFFLINE', moderationStatus: 'APPROVED' }), false)).toBe('off')
  })

  test('审核态为 null（加审核列之前的老行）读作「已下架」，不当成审核中', () => {
    expect(segmentOf(card({ status: 'OFFLINE', moderationStatus: null }), false)).toBe('off')
  })

  test('审核态只在 OFFLINE 时参与分档：ACTIVE / RESERVED / SOLD 都不因它换段', () => {
    // 审核态与商品状态是两条独立的轴：放行后（APPROVED）的商品不该因为库里还留着
    // REVIEW 的审计痕迹而被划进「审核」段
    for (const status of ['ACTIVE', 'RESERVED', 'SOLD'] as const) {
      expect(segmentOf(card({ status, moderationStatus: 'BLOCKED' }), false)).toBe(
        segmentOf(card({ status, moderationStatus: 'APPROVED' }), false),
      )
    }
  })
})

describe('segmentOf —— 有买家在等（awaiting）时进「待确认」', () => {
  test('在售 + 有买家在等 → 待确认；没有在等 → 在售', () => {
    expect(segmentOf(card(), true)).toBe('pending')
    expect(segmentOf(card(), false)).toBe('sale')
  })

  test('awaiting 只对 ACTIVE 起作用：已下架 / 已售出 / 审核中不因它换段', () => {
    // 一件自己下架的商品上挂着未回应的申请，读到的仍是「已下架」——
    // 换段会让分段计数与列表对不上
    expect(segmentOf(card({ status: 'OFFLINE' }), true)).toBe('off')
    expect(segmentOf(card({ status: 'OFFLINE', moderationStatus: 'BLOCKED' }), true)).toBe('review')
    expect(segmentOf(card({ status: 'SOLD' }), true)).toBe('sold')
  })

  test('RESERVED 无论如何都在「待确认」（已同意、待面交）', () => {
    expect(segmentOf(card({ status: 'RESERVED' }), true)).toBe('pending')
  })
})

describe('countBySegment —— 分段计数', () => {
  test('五种状态各计一段', () => {
    const counts = countBySegment([
      card(),
      card({ status: 'OFFLINE', moderationStatus: 'REVIEW' }),
      card({ status: 'OFFLINE', moderationStatus: 'BLOCKED' }),
      card({ status: 'RESERVED' }),
      card({ status: 'OFFLINE' }),
      card({ status: 'OFFLINE' }),
      card({ status: 'SOLD' }),
    ])
    expect(counts).toEqual({ sale: 1, review: 2, pending: 1, sold: 1, off: 2 })
  })

  test('awaiting 集合把在售的卡片挪进「待确认」，总数守恒', () => {
    const cards = [card({ id: 'a' }), card({ id: 'b' }), card({ id: 'c', status: 'SOLD' })]
    const counts = countBySegment(cards, new Set(['a']))
    expect(counts).toEqual({ sale: 1, review: 0, pending: 1, sold: 1, off: 0 })
    expect(Object.values(counts).reduce((sum, n) => sum + n, 0)).toBe(cards.length)
  })
})

describe('SEGMENTS / segmentLabel —— 五段顺序与名字', () => {
  test('「审核」排在「在售」之后、交易段之前', () => {
    // 阅读顺序 = 商品生命周期：发布后先过审，然后才可能有人点「我想要」
    expect(SEGMENTS.map((seg) => seg.key)).toEqual(['sale', 'review', 'pending', 'sold', 'off'])
  })

  test('各段的名字', () => {
    expect(segmentLabel('sale')).toBe('在售')
    expect(segmentLabel('review')).toBe('审核')
    expect(segmentLabel('pending')).toBe('待确认')
    expect(segmentLabel('sold')).toBe('已售出')
    expect(segmentLabel('off')).toBe('已下架')
  })
})

describe('cardLabel —— 两段里的子状态要分开说', () => {
  test('「审核」段：REVIEW → 审核中，BLOCKED → 不过审', () => {
    expect(cardLabel('review', false, 'REVIEW')).toBe('审核中')
    expect(cardLabel('review', false, 'BLOCKED')).toBe('不过审')
  })

  test('「待确认」段：有买家在等 → 待确认；已同意待面交 → 待面交', () => {
    /*
     * 这两种子状态在同一段里，但卡片正文一个写「谁点了我想要」、另一个写「已同意 · 等面交」。
     * 胶囊如果都顶「待确认」，后者的卡面就自相矛盾（同一张卡既说待确认又说已同意）。
     */
    expect(cardLabel('pending', true, null)).toBe('待确认')
    expect(cardLabel('pending', false, null)).toBe('待面交')
  })

  test('其余三段与分段名一致（awaiting / moderation 不影响它们）', () => {
    expect(cardLabel('sale', false, null)).toBe('在售')
    expect(cardLabel('sold', false, null)).toBe('已售出')
    expect(cardLabel('off', false, null)).toBe('已下架')
    expect(cardLabel('sale', true, null)).toBe('在售')
  })
})

describe('pillClassOf —— 胶囊配色按子状态分档', () => {
  test('「审核」段：审核中与不过审不同色', () => {
    expect(pillClassOf('review', 'REVIEW')).toBe('is-review')
    expect(pillClassOf('review', 'BLOCKED')).toBe('is-blocked')
  })

  test('其余各段与旧配色一致', () => {
    expect(pillClassOf('sale', null)).toBe('is-sale')
    expect(pillClassOf('pending', null)).toBe('is-pending')
    expect(pillClassOf('sold', null)).toBe('is-sold')
    expect(pillClassOf('off', null)).toBe('is-off')
  })
})

describe('lockNote —— 已售出与审核中各有说明', () => {
  test('审核中给「暂不可修改」，不过审不给（它的出路是编辑 / 删除）', () => {
    expect(lockNote('review', 'REVIEW')).not.toBe('')
    // 不过审的卡片上有编辑与删除两个按钮，再挂一句「不可修改」就是自相矛盾
    expect(lockNote('review', 'BLOCKED')).toBe('')
  })

  test('已售出给说明，待确认不给', () => {
    expect(lockNote('sold')).not.toBe('')
    // 待确认的「先别改」由「谁在等」那行 + 决策按钮表达，挂锁图标会跟旁边的按钮打架（稿 ⑥）
    expect(lockNote('pending')).toBe('')
    expect(lockNote('off')).toBe('')
  })
})

describe('emptyTitle / emptyText —— 空态说明该段会出现什么', () => {
  test('各段的标题互不相同，不复用同一句', () => {
    const titles = (['sale', 'review', 'pending', 'sold', 'off'] as const).map(emptyTitle)
    expect(new Set(titles).size).toBe(titles.length)
  })

  test('审核段为空时说清「新发布的商品会先经过这里」', () => {
    expect(emptyText('review')).toContain('审核')
  })

  test('待确认为空时说清「买家点了我想要才会来」', () => {
    expect(emptyText('pending')).toContain('我想要')
  })

  test('已下架的空态说清「可以重新上架」', () => {
    expect(emptyText('off')).toContain('重新上架')
  })
})
