// ---------------------------------------------------------------------------
// #322 M3 的排序质量测试（Issue 的 "人工标注 fixture + v1/semantic-only/hybrid
// 对比 + 权重与阈值在证据基础上冻结" 验收项）。
//
// 断言的是"拿到人工 cosine 之后的归一化 + 加权排序是否符合人工判断"，不出网、
// 不碰 DB。权重冻结的证据（四组对照的分数与排名表）由 `bun run rank:compare`
// 复算，设计文档 §权重冻结贴的是它的输出。
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test'
import {
  MATCH_SCORE_THRESHOLD,
  RANKING_VERSION,
  RANKING_VERSION_V1,
  SEMANTIC_SCORE_CEILING,
  SEMANTIC_SCORE_FLOOR,
} from '@fish/contracts/matching/schema'
import { RANKING_FIXTURE, type RankingSample } from './ranking-fixture'
import {
  normalizeSimilarity,
  type RankingWeights,
  SEMANTIC_WEIGHT_CANDIDATES,
  scoreMatch,
  scoreMatchWithWeights,
  WEIGHTS_V2,
} from './scoring'

function frozenScore(sample: RankingSample): number {
  return scoreMatch(sample.listing, sample.wish, { similarity: sample.similarity }).score
}

function candidateScore(sample: RankingSample, weights: RankingWeights): number {
  return scoreMatchWithWeights(
    sample.listing,
    sample.wish,
    { similarity: sample.similarity },
    weights,
  ).score
}

function divergences(weights: RankingWeights): string[] {
  return RANKING_FIXTURE.filter(
    (sample) => candidateScore(sample, weights) >= MATCH_SCORE_THRESHOLD !== sample.expectMatch,
  ).map((sample) => sample.id)
}

describe('人工标注 fixture 覆盖 Issue 点名的九类样本', () => {
  test('九类各至少一条，且每条都写了理由', () => {
    const classes = new Set(RANKING_FIXTURE.map((sample) => sample.sampleClass))
    expect(classes.size).toBe(9)
    for (const sample of RANKING_FIXTURE) {
      expect(sample.rationale.length).toBeGreaterThan(10)
    }
  })
})

describe('冻结权重（S4）下每条样本的判定与人工判断一致', () => {
  for (const sample of RANKING_FIXTURE) {
    test(`${sample.id}（${sample.sampleClass}）`, () => {
      const breakdown = scoreMatch(sample.listing, sample.wish, { similarity: sample.similarity })
      expect(breakdown.rankingVersion).toBe(RANKING_VERSION)
      // acceptSimilar=false 的"语义不能单独成立"门禁（M4 口径：只有关键词命中才算结构支撑）
      // 只在该对没有关键词支撑时把语义分记 0。
      const hasNonSemanticSupport = sample.wish.acceptSimilar || breakdown.keywordScore > 0
      expect(breakdown.semanticScore).toBe(
        hasNonSemanticSupport ? normalizeSimilarity(sample.similarity) : 0,
      )
      expect(breakdown.score >= MATCH_SCORE_THRESHOLD).toBe(sample.expectMatch)
    })
  }

  test('锚点与阈值被冻结（M4 重标定值；改动必须带 calibration/fit 证据）', () => {
    expect(MATCH_SCORE_THRESHOLD).toBe(70)
    expect(SEMANTIC_SCORE_FLOOR).toBe(0.42)
    expect(SEMANTIC_SCORE_CEILING).toBe(0.7)
  })

  test('12/12 一致 ⇒ 阈值 70 不需要改（改阈值必须重跑本 fixture 并给出证据）', () => {
    expect(MATCH_SCORE_THRESHOLD).toBe(70)
    const wrong = RANKING_FIXTURE.filter(
      (sample) => frozenScore(sample) >= 70 !== sample.expectMatch,
    )
    expect(wrong).toEqual([])
  })
})

describe('hybrid 的增量：v1 判不出的语义近似，v2 能召回', () => {
  test('同分类 + 无 substring 命中的同义表达：v1 < 阈值，v2 >= 阈值', () => {
    const sample = RANKING_FIXTURE.find((item) => item.id === 'k380-synonym-same-category')
    expect(sample).toBeDefined()
    if (!sample) return
    const v1 = scoreMatch(sample.listing, sample.wish, null)
    expect(v1.score).toBeLessThan(MATCH_SCORE_THRESHOLD)
    expect(v1.semanticScore).toBeNull()
    expect(v1.rankingVersion).toBe(RANKING_VERSION_V1)
    expect(frozenScore(sample)).toBeGreaterThanOrEqual(MATCH_SCORE_THRESHOLD)
  })

  test('品牌/型号表达（愿望“苹果降噪耳机” ↔ 商品“AirPods Pro 2 USB-C”）：v1 < 阈值，v2 >= 阈值', () => {
    const sample = RANKING_FIXTURE.find((item) => item.id === 'airpods-brand-model')
    expect(sample).toBeDefined()
    if (!sample) return
    expect(scoreMatch(sample.listing, sample.wish, null).score).toBeLessThan(MATCH_SCORE_THRESHOLD)
    expect(frozenScore(sample)).toBeGreaterThanOrEqual(MATCH_SCORE_THRESHOLD)
  })
})

describe('acceptSimilar 产生可验证差异', () => {
  test('同一对只差 acceptSimilar：false 被门禁记 0 且不匹配，true 参与语义分且匹配', () => {
    const blocked = RANKING_FIXTURE.find((item) => item.id === 'any-category-similar-false')
    const allowed = RANKING_FIXTURE.find((item) => item.id === 'any-category-similar-true')
    expect(blocked).toBeDefined()
    expect(allowed).toBeDefined()
    if (!blocked || !allowed) return

    expect(blocked.listing).toEqual(allowed.listing)
    expect(blocked.similarity).toBe(allowed.similarity)
    expect(blocked.wish.acceptSimilar).toBe(false)
    expect(allowed.wish.acceptSimilar).toBe(true)
    // 两条愿望的其余字段必须完全相同，否则不是"只差 acceptSimilar"的对照。
    const { acceptSimilar: blockedFlag, ...blockedRest } = blocked.wish
    const { acceptSimilar: allowedFlag, ...allowedRest } = allowed.wish
    expect(blockedFlag).not.toBe(allowedFlag)
    expect(blockedRest).toEqual(allowedRest)

    const blockedBreakdown = scoreMatch(blocked.listing, blocked.wish, {
      similarity: blocked.similarity,
    })
    const allowedBreakdown = scoreMatch(allowed.listing, allowed.wish, {
      similarity: allowed.similarity,
    })
    expect(blockedBreakdown.semanticScore).toBe(0)
    expect(allowedBreakdown.semanticScore).toBe(normalizeSimilarity(allowed.similarity))
    expect(blockedBreakdown.score).toBeLessThan(MATCH_SCORE_THRESHOLD)
    expect(allowedBreakdown.score).toBeGreaterThanOrEqual(MATCH_SCORE_THRESHOLD)
  })
})

describe('结构化硬约束不被语义绕过', () => {
  test('分类不符 + 关键词命中 + 高语义：冻结权重下仍在阈值以下', () => {
    const sample = RANKING_FIXTURE.find((item) => item.id === 'keyboard-books-category-mismatch')
    expect(sample).toBeDefined()
    if (!sample) return
    expect(sample.similarity).toBeGreaterThan(0.85)
    expect(frozenScore(sample)).toBeLessThan(MATCH_SCORE_THRESHOLD)
  })

  test('结构全中但语义分为 0（stub 环境的现实）：仍 >= 阈值，core smoke 的 K380 demo 依赖它', () => {
    const sample = RANKING_FIXTURE.find((item) => item.id === 'k380-exact-lexical')
    expect(sample).toBeDefined()
    if (!sample) return
    const breakdown = scoreMatch(sample.listing, sample.wish, {
      similarity: SEMANTIC_SCORE_FLOOR,
    })
    expect(breakdown.semanticScore).toBe(0)
    expect(breakdown.score).toBeGreaterThanOrEqual(MATCH_SCORE_THRESHOLD)
  })

  test('不限分类 + 无关键词命中 + 语义满分：能过阈值（语义召回对不限分类的愿望也成立）', () => {
    const sample = RANKING_FIXTURE.find((item) => item.id === 'any-category-similar-true')
    expect(sample).toBeDefined()
    if (!sample) return
    const breakdown = scoreMatch(
      sample.listing,
      { ...sample.wish, keyword: '完全不相关的词' },
      { similarity: 1 },
    )
    expect(breakdown.keywordScore).toBe(0)
    expect(breakdown.score).toBeGreaterThanOrEqual(MATCH_SCORE_THRESHOLD)
  })
})

describe('对照组与人工判断的偏差被冻结（改权重会立刻在这里报出差异）', () => {
  /**
   * M4 重标定后重算的偏差表（口径 = 新锚点 0.42/0.70 + `satisfied` + `keyword-only`）。
   *
   * 与 M3 表（`docs/design/issue-322-matching-v2-m3.md` §权重冻结）的差别是**锚点变了**：
   * 新锚点下真实相似度 0.88–0.93 会饱和到语义满分，三组对照的差异因此收敛到唯一一条——
   * `keyboard-books-category-mismatch`（分类不符 + 关键词命中 + 高语义）。S4 是唯一把
   * "分类不符时结构权重和 + 语义独立分项"压在阈值以下的组合（0.30×100 + 0.32×0 + 0.15×100
   * + 0.23×100 = 68 < 70；S1 = 75、S2 = 70、S3 = 75），所以权重仍然冻结在 S4。
   */
  const EXPECTED_DIVERGENCES: Record<keyof typeof SEMANTIC_WEIGHT_CANDIDATES, string[]> = {
    S1: ['keyboard-books-category-mismatch'],
    S2: ['keyboard-books-category-mismatch'],
    S3: ['keyboard-books-category-mismatch'],
    S4: [],
  }

  for (const label of Object.keys(EXPECTED_DIVERGENCES) as Array<
    keyof typeof SEMANTIC_WEIGHT_CANDIDATES
  >) {
    test(`${label}：与人工判断不一致的样本 = ${EXPECTED_DIVERGENCES[label].length} 条`, () => {
      expect(divergences(SEMANTIC_WEIGHT_CANDIDATES[label]).sort()).toEqual(
        [...EXPECTED_DIVERGENCES[label]].sort(),
      )
    })
  }

  test('冻结的就是 S4（12/12 一致的那一组）', () => {
    expect(WEIGHTS_V2).toEqual(SEMANTIC_WEIGHT_CANDIDATES.S4)
    expect(divergences(WEIGHTS_V2)).toEqual([])
  })
})
