import { describe, expect, test } from 'bun:test'
import {
  RANK_NEGATIVE_FEEDBACK_HALF_SATURATION,
  RANK_NEGATIVE_FEEDBACK_WEIGHTS,
} from '@fish/contracts/recommendation/rank'
import type { NegativeFeedbackAggregate } from '@fish/db/recall-store'
import {
  buildNegativeFeedbackSignals,
  emptyNegativeFeedbackSignals,
  NEGATIVE_FEEDBACK_SQL_WEIGHTS,
  pickNegativeFeedback,
} from './feedback'

/**
 * 负反馈信号单测（#323 R4 / M4；#524 起聚合与衰减下推到 SQL）。
 *
 * 衰减 × 权重 × 分组求和由 `aggregateNegativeFeedback` 负责（`packages/db/src/recall-store.test.ts`
 * 用真库钉住）；这里只钉纯函数部分：① 喂给 SQL 的权重表与契约同源；② 聚合 → 饱和映射；
 * ③ 类目与卖家取 `max` 而不是相加 —— 相加会让软惩罚越过 1，把"软"悄悄变成"硬"。
 */

function aggregate(overrides: Partial<NegativeFeedbackAggregate> = {}): NegativeFeedbackAggregate {
  return { categoryWeights: [], sellerWeights: [], hiddenListingIds: [], ...overrides }
}

/** 单条 HIDE（|weight| = 3）的软惩罚：`saturatingRatio(3, 2) = 0.6`。 */
const HIDE_PENALTY = 3 / (3 + RANK_NEGATIVE_FEEDBACK_HALF_SATURATION)

describe('NEGATIVE_FEEDBACK_SQL_WEIGHTS', () => {
  test('与契约的负反馈权重表同源，且都是正数（SQL 侧按正权重求和）', () => {
    expect(NEGATIVE_FEEDBACK_SQL_WEIGHTS).toEqual([
      { eventType: 'HIDE', weight: RANK_NEGATIVE_FEEDBACK_WEIGHTS.HIDE },
      { eventType: 'UNFAVORITE', weight: RANK_NEGATIVE_FEEDBACK_WEIGHTS.UNFAVORITE },
      { eventType: 'QUICK_SKIP', weight: RANK_NEGATIVE_FEEDBACK_WEIGHTS.QUICK_SKIP },
    ])
    for (const row of NEGATIVE_FEEDBACK_SQL_WEIGHTS) expect(row.weight).toBeGreaterThan(0)
  })
})

describe('buildNegativeFeedbackSignals', () => {
  test('聚合权重按 saturatingRatio 映射，类目与卖家各记各的；隐藏集合原样透传', () => {
    const signals = buildNegativeFeedbackSignals(
      aggregate({
        categoryWeights: [
          { category: 'DIGITAL', weight: 3 },
          { category: 'BOOKS', weight: 0.5 },
        ],
        sellerWeights: [{ sellerId: 'seller-1', weight: 3 }],
        hiddenListingIds: ['listing-1'],
      }),
    )

    expect(signals.categoryPenalty.get('DIGITAL')).toBeCloseTo(HIDE_PENALTY, 12)
    expect(signals.categoryPenalty.get('BOOKS')).toBeCloseTo(
      0.5 / (0.5 + RANK_NEGATIVE_FEEDBACK_HALF_SATURATION),
      12,
    )
    expect(signals.sellerPenalty.get('seller-1')).toBeCloseTo(HIDE_PENALTY, 12)
    expect([...signals.hiddenListingIds]).toEqual(['listing-1'])
  })

  test('非正 / 非有限的权重不产生惩罚（不让坏数据变成 NaN 分数）', () => {
    const signals = buildNegativeFeedbackSignals(
      aggregate({
        categoryWeights: [
          { category: 'DIGITAL', weight: 0 },
          { category: 'BOOKS', weight: Number.NaN },
        ],
      }),
    )
    expect(signals.categoryPenalty.size).toBe(0)
  })
})

describe('pickNegativeFeedback', () => {
  const signals = buildNegativeFeedbackSignals(
    aggregate({
      categoryWeights: [{ category: 'DIGITAL', weight: 3 }],
      sellerWeights: [{ sellerId: 'seller-1', weight: 3 }],
    }),
  )

  test('类目与卖家取 max，不相加（相加会把软惩罚推过 1）', () => {
    const picked = pickNegativeFeedback(signals, { category: 'DIGITAL', sellerId: 'seller-1' })
    expect(picked).toBeCloseTo(HIDE_PENALTY, 12)
    expect(picked).toBeLessThanOrEqual(1)
  })

  test('只命中一边时取那一边；都不命中为 0', () => {
    expect(pickNegativeFeedback(signals, { category: 'DIGITAL', sellerId: 'other' })).toBeCloseTo(
      HIDE_PENALTY,
      12,
    )
    expect(pickNegativeFeedback(signals, { category: 'BOOKS', sellerId: 'seller-1' })).toBeCloseTo(
      HIDE_PENALTY,
      12,
    )
    expect(pickNegativeFeedback(signals, { category: 'BOOKS', sellerId: 'other' })).toBe(0)
  })

  test('空信号恒为 0（冷启动/无身份路径）', () => {
    expect(
      pickNegativeFeedback(emptyNegativeFeedbackSignals(), { category: 'DIGITAL', sellerId: 's' }),
    ).toBe(0)
  })
})
