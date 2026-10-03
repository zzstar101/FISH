import { describe, expect, test } from 'bun:test'
import { INTEREST_HALF_LIFE_MS } from '@fish/contracts/recommendation/interest'
import { RANK_NEGATIVE_FEEDBACK_HALF_SATURATION } from '@fish/contracts/recommendation/rank'
import type { NegativeFeedbackEvent } from '@fish/db/recall-store'
import {
  buildNegativeFeedbackSignals,
  emptyNegativeFeedbackSignals,
  pickNegativeFeedback,
} from './feedback'

/**
 * 负反馈信号单测（#323 R4 / M4）。
 *
 * 钉三件事：① 硬排除只给"针对这一件商品"的表态（HIDE），类目/卖家只做软惩罚；
 * ② 时间衰减用长期半衰期、未来时间戳不退化成 NaN；③ 类目与卖家取 `max` 而不是相加 ——
 * 相加会让软惩罚越过 1，把"软"悄悄变成"硬"。
 */

const NOW = new Date('2026-10-02T12:00:00.000Z')

function event(overrides: Partial<NegativeFeedbackEvent> = {}): NegativeFeedbackEvent {
  return {
    listingId: 'listing-1',
    category: 'DIGITAL',
    sellerId: 'seller-1',
    eventType: 'HIDE',
    occurredAt: NOW,
    ...overrides,
  }
}

/** 单条 HIDE（|weight| = 3）在 age = 0 时的软惩罚：`saturatingRatio(3, 2) = 0.6`。 */
const HIDE_AT_NOW = 3 / (3 + RANK_NEGATIVE_FEEDBACK_HALF_SATURATION)

describe('buildNegativeFeedbackSignals', () => {
  test('HIDE 进硬排除集合；UNFAVORITE / QUICK_SKIP 只做软惩罚', () => {
    const hidden = buildNegativeFeedbackSignals({
      events: [event({ eventType: 'HIDE' })],
      now: NOW,
    })
    expect(hidden.hiddenListingIds.has('listing-1')).toBe(true)

    for (const eventType of ['UNFAVORITE', 'QUICK_SKIP'] as const) {
      const signals = buildNegativeFeedbackSignals({ events: [event({ eventType })], now: NOW })
      // 硬排除只留给"针对这一件商品"的明确表态：划过/取关不等于"永远别再给我看这件"。
      expect(signals.hiddenListingIds.size).toBe(0)
      expect(signals.categoryPenalty.get('DIGITAL')).toBeGreaterThan(0)
      expect(signals.sellerPenalty.get('seller-1')).toBeGreaterThan(0)
    }
  })

  test('单条 HIDE 的软惩罚 = saturatingRatio(3, 2) = 0.6，且类目与卖家各记一份', () => {
    const signals = buildNegativeFeedbackSignals({ events: [event()], now: NOW })
    expect(signals.categoryPenalty.get('DIGITAL')).toBeCloseTo(HIDE_AT_NOW, 12)
    expect(signals.sellerPenalty.get('seller-1')).toBeCloseTo(HIDE_AT_NOW, 12)
  })

  test('衰减用长期半衰期：恰好一个半衰期后权重减半', () => {
    const aged = new Date(NOW.getTime() - INTEREST_HALF_LIFE_MS.longTerm)
    const signals = buildNegativeFeedbackSignals({
      events: [event({ occurredAt: aged })],
      now: NOW,
    })

    const halved = 1.5 / (1.5 + RANK_NEGATIVE_FEEDBACK_HALF_SATURATION)
    expect(signals.categoryPenalty.get('DIGITAL')).toBeCloseTo(halved, 12)
    // 半衰期用的是"长期"口径（14 天）而不是 session 口径（30 分钟）：负反馈是"我对这类东西的
    // 态度"，不该因为半小时没动作就复位。
    expect(signals.categoryPenalty.get('DIGITAL')).toBeGreaterThan(0.4)
  })

  test('未来时间戳按"刚刚发生"算满权重，不让负 age 把衰减推到 >1 或 NaN', () => {
    const future = new Date(NOW.getTime() + 60_000)
    const signals = buildNegativeFeedbackSignals({
      events: [event({ occurredAt: future })],
      now: NOW,
    })
    expect(signals.categoryPenalty.get('DIGITAL')).toBeCloseTo(HIDE_AT_NOW, 12)
  })

  test('同类目多条累加后再饱和：越多越接近 1 但永远 < 1', () => {
    const one = buildNegativeFeedbackSignals({
      events: [event({ eventType: 'QUICK_SKIP' })],
      now: NOW,
    })
    const three = buildNegativeFeedbackSignals({
      events: [
        event({ eventType: 'QUICK_SKIP', listingId: 'l1' }),
        event({ eventType: 'QUICK_SKIP', listingId: 'l2' }),
        event({ eventType: 'QUICK_SKIP', listingId: 'l3' }),
      ],
      now: NOW,
    })

    const oneValue = one.categoryPenalty.get('DIGITAL') ?? 0
    const threeValue = three.categoryPenalty.get('DIGITAL') ?? 0
    expect(threeValue).toBeGreaterThan(oneValue)
    expect(threeValue).toBeLessThan(1)
    // 单条 QUICK_SKIP 权重 0.5 → 0.5 / 2.5 = 0.2。
    expect(oneValue).toBeCloseTo(0.5 / (0.5 + RANK_NEGATIVE_FEEDBACK_HALF_SATURATION), 12)
  })

  test('强度阶梯 HIDE > UNFAVORITE > QUICK_SKIP 在惩罚值上可见', () => {
    const value = (eventType: NegativeFeedbackEvent['eventType']): number =>
      buildNegativeFeedbackSignals({
        events: [event({ eventType })],
        now: NOW,
      }).categoryPenalty.get('DIGITAL') ?? 0

    expect(value('HIDE')).toBeGreaterThan(value('UNFAVORITE'))
    expect(value('UNFAVORITE')).toBeGreaterThan(value('QUICK_SKIP'))
  })

  test('不同类目/卖家各记各的，不串味', () => {
    const signals = buildNegativeFeedbackSignals({
      events: [
        event({ listingId: 'l1', category: 'DIGITAL', sellerId: 'seller-1' }),
        event({ listingId: 'l2', category: 'BOOKS', sellerId: 'seller-2' }),
      ],
      now: NOW,
    })

    expect(signals.categoryPenalty.get('DIGITAL')).toBeCloseTo(HIDE_AT_NOW, 12)
    expect(signals.categoryPenalty.get('BOOKS')).toBeCloseTo(HIDE_AT_NOW, 12)
    expect(signals.sellerPenalty.get('seller-1')).toBeCloseTo(HIDE_AT_NOW, 12)
    expect(signals.sellerPenalty.get('seller-2')).toBeCloseTo(HIDE_AT_NOW, 12)
  })

  test('权重表里没有的事件类型（兜底路径）不产生任何惩罚', () => {
    // `findNegativeFeedbackEvents` 已经按类型过滤过；这里模拟上游漏过滤时的兜底：
    // 表里没有的类型权重按 0，而不是抛错或当成 1。
    const signals = buildNegativeFeedbackSignals({
      events: [event({ eventType: 'DETAIL_VIEW' })],
      now: NOW,
    })
    expect(signals.hiddenListingIds.size).toBe(0)
    expect(signals.categoryPenalty.size).toBe(0)
    expect(signals.sellerPenalty.size).toBe(0)
  })

  test('空事件 → 空信号；两次调用不共享可变容器', () => {
    const empty = buildNegativeFeedbackSignals({ events: [], now: NOW })
    expect(empty.hiddenListingIds.size).toBe(0)
    expect(empty.categoryPenalty.size).toBe(0)
    expect(empty.sellerPenalty.size).toBe(0)

    const first = buildNegativeFeedbackSignals({ events: [event()], now: NOW })
    const second = buildNegativeFeedbackSignals({ events: [], now: NOW })
    expect(second.categoryPenalty.size).toBe(0)
    expect(first.categoryPenalty.size).toBe(1)
  })
})

describe('pickNegativeFeedback', () => {
  test('类目与卖家取 max，不相加（相加会把软惩罚推过 1）', () => {
    const signals = buildNegativeFeedbackSignals({ events: [event()], now: NOW })
    const picked = pickNegativeFeedback(signals, { category: 'DIGITAL', sellerId: 'seller-1' })
    // 同一个 HIDE 事件同时落在类目与卖家上，两边证据是同一件事：max = 0.6，sum 会是 1.2。
    expect(picked).toBeCloseTo(HIDE_AT_NOW, 12)
    expect(picked).toBeLessThanOrEqual(1)
  })

  test('只命中一边时取那一边；都不命中为 0', () => {
    const signals = buildNegativeFeedbackSignals({ events: [event()], now: NOW })
    expect(pickNegativeFeedback(signals, { category: 'DIGITAL', sellerId: 'other' })).toBeCloseTo(
      HIDE_AT_NOW,
      12,
    )
    expect(pickNegativeFeedback(signals, { category: 'BOOKS', sellerId: 'seller-1' })).toBeCloseTo(
      HIDE_AT_NOW,
      12,
    )
    expect(pickNegativeFeedback(signals, { category: 'BOOKS', sellerId: 'other' })).toBe(0)
  })

  test('空信号恒为 0（冷启动/无身份路径的降级值）', () => {
    expect(
      pickNegativeFeedback(emptyNegativeFeedbackSignals(), { category: 'DIGITAL', sellerId: 's' }),
    ).toBe(0)
  })
})

describe('emptyNegativeFeedbackSignals', () => {
  test('返回三个互不共享的空容器（调用方可以安全地各写各的）', () => {
    const a = emptyNegativeFeedbackSignals()
    const b = emptyNegativeFeedbackSignals()
    expect(a.hiddenListingIds).not.toBe(b.hiddenListingIds)
    expect(a.categoryPenalty).not.toBe(b.categoryPenalty)
    expect(a.sellerPenalty).not.toBe(b.sellerPenalty)
    expect(a.hiddenListingIds.size).toBe(0)
  })
})
