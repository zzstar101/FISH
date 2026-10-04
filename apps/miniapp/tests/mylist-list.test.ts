import { describe, expect, test } from 'bun:test'
import {
  canDelete,
  canEdit,
  canOffline,
  cardLabel,
  countBySegment,
  emptyText,
  emptyTitle,
  lockNote,
  pillClassOf,
  SEGMENTS,
  segmentLabel,
  segmentOf,
} from '../src/pkg-browse/pages/mylist/list'

/**
 * 「我的发布」分档与动作判据（#74 / #89 mylist 行真实接线；「审核」段见 Owner 2026-09-28 拍板）。
 * 组件接线没有单测（本仓 tests/ 只有纯逻辑测试，无 Taro 组件渲染基线）。
 *
 * 四组最容易做错的边界：
 *
 * 1. **「审核」段要同时读 `status` 与 `moderationStatus`**：审核中（`REVIEW`）与不过审
 *    （`BLOCKED`）在库里都是 `status = OFFLINE`，只看 `status` 会把它们跟「自己下架的」
 *    混成一段，两种子状态的动作（等结论 vs 编辑/删除）也就无从区分。
 * 2. **治理下架（`governanceDelisted`）要从这一段里挑出去**：它与「不过审」在库里**同形**
 *    （`OFFLINE` + `BLOCKED`），出路却完全不同（找平台 vs 改内容重审），而且它的
 *    编辑 / 重新上架 / 删除在服务端一律 409 —— 归错段就会出现「按钮在、按下去必然失败」。
 * 3. **`moderationStatus = null` 读作「已下架」**：契约里该字段只在查自己时非 null
 *    （本页正是查自己），真正的 `null` 只可能出现在公开 / 他人视角；判成「已下架」是取最保守落点。
 * 4. **「待确认」有两个来源**：`RESERVED`（卖家已同意、待面交），以及**商品仍是 `ACTIVE`
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

  test('审核态为 null 读作「已下架」，不当成审核中', () => {
    // 该列在库里是 NOT NULL DEFAULT 'APPROVED'，`null` 只可能来自非本人视角；
    // 判成「已下架」是保守落点（宁可少给动作，也不同把已放行的商品划进审核段）
    expect(segmentOf(card({ status: 'OFFLINE', moderationStatus: null }), false)).toBe('off')
  })

  test('治理下架归「已下架」段，不与「不过审」混为一谈', () => {
    // 两者在库里都是 OFFLINE + BLOCKED（见 governance/service.ts 的 delist）；
    // 只有 governance_delisted_at 能分开，契约把它投影成 `governanceDelisted`
    expect(
      segmentOf(
        card({ status: 'OFFLINE', moderationStatus: 'BLOCKED', governanceDelisted: true }),
        false,
      ),
    ).toBe('off')
    // 没有治理标记的同形态商品仍在「审核」段
    expect(
      segmentOf(
        card({ status: 'OFFLINE', moderationStatus: 'BLOCKED', governanceDelisted: false }),
        false,
      ),
    ).toBe('review')
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

  test('「已下架」段里的平台下架另有名字', () => {
    // 商品确实不在架上了，所以归「已下架」；但卖家能做的是找平台，
    // 与「自己下架、随时可重新上架」不是一回事 —— 名字必须分开
    expect(cardLabel('off', false, 'BLOCKED', true)).toBe('平台下架')
    expect(cardLabel('off', false, 'APPROVED', true)).toBe('平台下架')
    expect(cardLabel('off', false, 'APPROVED', false)).toBe('已下架')
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

  test('平台下架的胶囊不落回中性的「已下架」描边色', () => {
    // 它与「不过审」同类（都被平台拦下），用同一档 danger 色；
    // 若落回 is-off，卡片看着就像卖家自己下架的普通商品
    expect(pillClassOf('off', 'APPROVED', true)).toBe('is-blocked')
    expect(pillClassOf('off', 'APPROVED', false)).toBe('is-off')
  })
})

describe('lockNote —— 已售出 / 审核中 / 平台下架各有说明', () => {
  test('审核中给「暂不可修改」，不过审不给（它的出路是编辑 / 删除）', () => {
    expect(lockNote('review', 'REVIEW')).toBe('审核期间暂不可修改')
    // 不过审的卡片上有编辑与删除两个按钮，再挂一句「不可修改」就是自相矛盾
    expect(lockNote('review', 'BLOCKED')).toBe('')
  })

  test('平台下架的说明要说出路是找平台，而不是「改一改再上架」', () => {
    const note = lockNote('off', 'BLOCKED', true)
    expect(note).toContain('平台下架')
    // 它没有任何按钮，所以这里必须说清为什么（服务端对编辑/上架一律 409）
    expect(note).toContain('不可')
    // 普通「已下架」不挂锁：它有自己的「重新上架」
    expect(lockNote('off', 'APPROVED', false)).toBe('')
  })

  test('已售出给说明，待确认不给', () => {
    expect(lockNote('sold')).toBe('已成交锁定 · 不可改')
    // 待确认的「先别改」由「谁在等」那行 + 决策按钮表达，挂锁图标会跟旁边的按钮打架（稿 ⑥）
    expect(lockNote('pending')).toBe('')
    expect(lockNote('off')).toBe('')
  })
})

/**
 * 三个动作的判据必须与「服务端会不会放行」一致 —— 卡面上摆一个按下去必然 409 的按钮，
 * 就是让用户白点一次。这里的每一条都对应一个服务端拒绝分支：
 * `canEdit=false`（审核中 / 平台下架）对应 `LISTING_GOVERNANCE_BLOCKED` 与交易锁定，
 * `canDelete=false`（除不过审之外的一切）对应 `LISTING_NOT_DELETABLE`。
 */
describe('canEdit / canOffline / canDelete —— 动作判据与服务端一致', () => {
  test('编辑：在售 / 已下架 / 不过审可编辑，其余都不可', () => {
    expect(canEdit('sale', 'APPROVED')).toBe(true)
    expect(canEdit('off', 'APPROVED')).toBe(true)
    expect(canEdit('review', 'BLOCKED')).toBe(true)
    // 审核中要等结论（拍板），待确认 / 已售出被交易锁定，平台下架服务端一律拒
    expect(canEdit('review', 'REVIEW')).toBe(false)
    expect(canEdit('pending', 'APPROVED')).toBe(false)
    expect(canEdit('sold', 'APPROVED')).toBe(false)
    expect(canEdit('off', 'BLOCKED', true)).toBe(false)
    expect(canEdit('review', 'BLOCKED', true)).toBe(false)
  })

  test('下架：只有在售可下架', () => {
    expect(canOffline('sale')).toBe(true)
    expect(canOffline('off')).toBe(false)
    expect(canOffline('review', false)).toBe(false)
    expect(canOffline('pending')).toBe(false)
    expect(canOffline('sold')).toBe(false)
    // 治理下架的形态是 OFFLINE + BLOCKED（本就不可能落在「在售」段），这里仍显式判否：
    // 判据不依赖「上游分档恰好不会给出这种组合」
    expect(canOffline('off', true)).toBe(false)
  })

  test('删除：只有不过审可删', () => {
    expect(canDelete('review', 'BLOCKED')).toBe(true)
    // 审核中等结论；已下架 / 在售 / 待确认 / 已售出各有去处；平台下架是治理证据
    expect(canDelete('review', 'REVIEW')).toBe(false)
    expect(canDelete('off', 'APPROVED')).toBe(false)
    expect(canDelete('sale', 'APPROVED')).toBe(false)
    expect(canDelete('pending', 'APPROVED')).toBe(false)
    expect(canDelete('sold', 'APPROVED')).toBe(false)
    expect(canDelete('review', 'BLOCKED', true)).toBe(false)
  })

  test('平台下架一律不给编辑 / 重新上架 / 删除（三个动作都被服务端拒）', () => {
    for (const segment of ['sale', 'review', 'pending', 'sold', 'off'] as const) {
      expect(canEdit(segment, 'BLOCKED', true)).toBe(false)
      expect(canOffline(segment, true)).toBe(false)
      expect(canDelete(segment, 'BLOCKED', true)).toBe(false)
    }
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
