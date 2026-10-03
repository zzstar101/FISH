import { describe, expect, test } from 'bun:test'
import {
  RANK_FEATURE_KEYS,
  RANK_FEATURE_WEIGHTS,
  RANK_POPULARITY_HALF_SATURATION,
  RANK_REPEATED_EXPOSURE_HALF_SATURATION,
  RANK_WISH_SCORE_MAX,
  type RankFeatureKey,
  RankScoreBreakdownSchema,
} from '@fish/contracts/recommendation/rank'
import type { RecallCandidate } from '../recall/types'
import type { NegativeFeedbackSignals } from './feedback'
import { compareScoredCandidates, type ScoredCandidate, scoreCandidates } from './score'

/**
 * R4 排序打分的单测（#323 R4 / M4）。
 *
 * 纯函数，无 DB：这里钉的是"单特征变化的单调性 + 缺失与 0 的区别 + 排序确定性"。三条都属于
 * **改错了不会崩、只会静默排错**的类型，所以必须靠断言而不是靠集成测试的顺序对比。
 */

const NOW = new Date('2026-10-02T12:00:00.000Z')

/** "问过了，确实没有任何负反馈"——用来把 negativeFeedback 从 missing 里摘出去。 */
const NO_FEEDBACK: NegativeFeedbackSignals = {
  hiddenListingIds: new Set<string>(),
  categoryPenalty: new Map<string, number>(),
  sellerPenalty: new Map<string, number>(),
}

/** 一条"什么信号都没有"的冷启动候选：所有 feature 都是 null，freshness 有值（R3 恒有）。 */
function candidate(overrides: Partial<RecallCandidate> = {}): RecallCandidate {
  return {
    listingId: 'listing-a',
    sellerId: 'seller-1',
    category: 'DIGITAL',
    recallSources: ['fresh'],
    semanticScore: null,
    wishScore: null,
    popularity: null,
    userCategoryAffinity: null,
    freshness: 0.5,
    createdAt: NOW,
    alreadySeenCount: 0,
    sellerExposure: 1,
    ...overrides,
  }
}

/** 只有一个候选时的分数（省掉"找那一条"的样板）。 */
function scoreOne(c: RecallCandidate, feedback: NegativeFeedbackSignals | null = NO_FEEDBACK) {
  const scored = scoreCandidates({ candidates: [c], feedback })
  const first = scored[0]
  if (!first) throw new Error('排序结果为空')
  return first
}

describe('scoreCandidates 归一化', () => {
  test('每项 feature 都是"归一化值 × 权重"，且 `rankScore` 恒等于明细贡献之和', () => {
    const scored = scoreOne(
      candidate({
        semanticScore: 0.8,
        wishScore: 50,
        userCategoryAffinity: 0.4,
        freshness: 1,
        popularity: RANK_POPULARITY_HALF_SATURATION,
        alreadySeenCount: RANK_REPEATED_EXPOSURE_HALF_SATURATION,
      }),
    )

    expect(scored.breakdown.semantic.normalized).toBeCloseTo(0.8, 12)
    expect(scored.breakdown.wish.normalized).toBeCloseTo(0.5, 12)
    expect(scored.breakdown.popularity.normalized).toBeCloseTo(0.5, 12)
    expect(scored.breakdown.repeatedExposure.normalized).toBeCloseTo(0.5, 12)

    for (const key of RANK_FEATURE_KEYS) {
      const item = scored.breakdown[key]
      expect(item.weight).toBe(RANK_FEATURE_WEIGHTS[key])
      expect(item.contribution).toBeCloseTo(item.normalized * item.weight, 12)
    }
    const sum = RANK_FEATURE_KEYS.reduce((acc, key) => acc + scored.breakdown[key].contribution, 0)
    expect(scored.rankScore).toBeCloseTo(sum, 12)
    expect(RankScoreBreakdownSchema.safeParse(scored.breakdown).success).toBe(true)
  })

  test('`semanticScore = -1` 截断到 0：负相似度没有"负贡献"的语义', () => {
    const scored = scoreOne(candidate({ semanticScore: -1 }))
    expect(scored.breakdown.semantic.normalized).toBe(0)
    // 有值但被截断 ≠ 缺失：它不该进 `missing`（否则离线评估会把它当成"没有语义信号"）。
    expect(scored.breakdown.missing).not.toContain('semantic')
  })

  test('`wishScore = 100` → 归一化 1.0；超上限也不会 >1', () => {
    expect(scoreOne(candidate({ wishScore: RANK_WISH_SCORE_MAX })).breakdown.wish.normalized).toBe(
      1,
    )
    // 万一上游给了 >100（DB CHECK 之外的路径），clamp 仍要守住 [0, 1]：明细 schema 会拒 >1。
    expect(scoreOne(candidate({ wishScore: 250 })).breakdown.wish.normalized).toBe(1)
  })

  test('每个正特征单独变大时 `rankScore` 不减（单调）', () => {
    expect(scoreOne(candidate({ semanticScore: 0.9 })).rankScore).toBeGreaterThan(
      scoreOne(candidate({ semanticScore: 0.1 })).rankScore,
    )
    expect(scoreOne(candidate({ wishScore: 90 })).rankScore).toBeGreaterThan(
      scoreOne(candidate({ wishScore: 1 })).rankScore,
    )
    expect(scoreOne(candidate({ userCategoryAffinity: 0.9 })).rankScore).toBeGreaterThan(
      scoreOne(candidate({ userCategoryAffinity: 0.1 })).rankScore,
    )
    expect(scoreOne(candidate({ freshness: 0.9 })).rankScore).toBeGreaterThan(
      scoreOne(candidate({ freshness: 0.2 })).rankScore,
    )
    expect(scoreOne(candidate({ popularity: 10 })).rankScore).toBeGreaterThan(
      scoreOne(candidate({ popularity: 1 })).rankScore,
    )
  })

  test('重复曝光越多分越低（负权重方向不能写反）', () => {
    expect(scoreOne(candidate({ alreadySeenCount: 0 })).rankScore).toBeGreaterThan(
      scoreOne(candidate({ alreadySeenCount: 8 })).rankScore,
    )
  })
})

describe('scoreCandidates 的"缺失 ≠ 0"', () => {
  test('`alreadySeenCount = null` ⇒ `missing` 含 repeatedExposure 且不扣分', () => {
    const unknown = scoreOne(candidate({ alreadySeenCount: null }))
    expect(unknown.breakdown.missing).toContain('repeatedExposure')
    expect(unknown.breakdown.repeatedExposure.normalized).toBe(0)
    // 缺失特征按 0 参与求和，负权重下浮点会得到 `-0`（JSON 序列化成 `0`，不影响落库）；
    // 用数值比较而不是 `toBe(0)`，避免把一个表示层细节当成契约。
    expect(unknown.breakdown.repeatedExposure.contribution).toBeCloseTo(0, 12)

    // 与"确实没曝光过"（0）相比：两者分数相同，但一个记 missing、一个不记 —— 这正是
    // R3 §9 待办①要保住的信息（未知不能被当成 0 之后又被当成已知）。
    const knownZero = scoreOne(candidate({ alreadySeenCount: 0 }))
    expect(knownZero.breakdown.missing).not.toContain('repeatedExposure')
    expect(knownZero.rankScore).toBeCloseTo(unknown.rankScore, 12)
  })

  test('冷启动（全空）时 missing 列出全部无值特征，freshness 不在其中', () => {
    const scored = scoreOne(candidate())
    const expected: RankFeatureKey[] = ['semantic', 'wish', 'category', 'popularity']
    expect([...scored.breakdown.missing].sort()).toEqual([...expected].sort())
    // freshness 由 R3 的 `freshnessOf` 保证恒有值。
    expect(scored.breakdown.missing).not.toContain('freshness')
  })

  test('`feedback = null`（负反馈查询失败/无身份）⇒ negativeFeedback 进 missing 而不是"没有负反馈"', () => {
    const scored = scoreOne(candidate(), null)
    expect(scored.breakdown.missing).toContain('negativeFeedback')
    expect(scored.breakdown.negativeFeedback.normalized).toBe(0)
    expect(scored.breakdown.missing).toContain('semantic')
  })

  test('有负反馈信号时按类目/卖家命中扣分（软惩罚方向为负）', () => {
    const signals: NegativeFeedbackSignals = {
      hiddenListingIds: new Set<string>(),
      categoryPenalty: new Map([['DIGITAL', 0.5]]),
      sellerPenalty: new Map<string, number>(),
    }
    const penalized = scoreOne(candidate(), signals)
    const clean = scoreOne(candidate({ category: 'BOOKS' }), signals)

    expect(penalized.breakdown.negativeFeedback.normalized).toBeCloseTo(0.5, 12)
    // 有信号 ⇒ 这一项是"已知"的（其余特征仍然未知，所以只断言这一项不在 missing 里）。
    expect(penalized.breakdown.missing).not.toContain('negativeFeedback')
    expect(penalized.rankScore).toBeCloseTo(
      clean.rankScore + 0.5 * RANK_FEATURE_WEIGHTS.negativeFeedback,
      12,
    )
    expect(penalized.rankScore).toBeLessThan(clean.rankScore)
  })
})

describe('排序确定性', () => {
  test('同分时按 `listingId` 升序，且同一输入两次调用逐位相同', () => {
    const candidates = [
      candidate({ listingId: 'c', freshness: 1 }),
      candidate({ listingId: 'a', freshness: 1 }),
      candidate({ listingId: 'b', freshness: 1 }),
    ]

    const first = scoreCandidates({ candidates, feedback: NO_FEEDBACK })
    const second = scoreCandidates({ candidates, feedback: NO_FEEDBACK })

    expect(first.map((item) => item.candidate.listingId)).toEqual(['a', 'b', 'c'])
    // 浮点分数与明细都要逐位相同：`sort` 的稳定性 + 固定遍历顺序是"同输入可复现"的全部依据。
    expect(second).toEqual(first)
  })

  test('分数高的在前；分数相同才轮到 listingId', () => {
    const scored = scoreCandidates({
      candidates: [
        candidate({ listingId: 'z', freshness: 1 }),
        candidate({ listingId: 'a', freshness: 0.1 }),
      ],
      feedback: NO_FEEDBACK,
    })
    expect(scored.map((item) => item.candidate.listingId)).toEqual(['z', 'a'])
  })

  test('`compareScoredCandidates` 是确定性全序：自反、反对称、同元素比出 0', () => {
    const [one, two] = scoreCandidates({
      candidates: [candidate({ listingId: 'a' }), candidate({ listingId: 'b', freshness: 0.9 })],
      feedback: NO_FEEDBACK,
    }) as [ScoredCandidate, ScoredCandidate]

    expect(compareScoredCandidates(one, one)).toBe(0)
    expect(Math.sign(compareScoredCandidates(one, two))).toBe(
      -Math.sign(compareScoredCandidates(two, one)),
    )
  })

  test('输入顺序不影响输出（调用方不排序时也不会得到另一个结果）', () => {
    const a = candidate({ listingId: 'a', freshness: 0.3 })
    const b = candidate({ listingId: 'b', freshness: 0.7 })
    const forward = scoreCandidates({ candidates: [a, b], feedback: NO_FEEDBACK })
    const backward = scoreCandidates({ candidates: [b, a], feedback: NO_FEEDBACK })
    expect(forward).toEqual(backward)
  })

  test('空候选集返回空数组（降级路径依赖它判"这页没东西"）', () => {
    expect(scoreCandidates({ candidates: [], feedback: NO_FEEDBACK })).toEqual([])
  })
})
