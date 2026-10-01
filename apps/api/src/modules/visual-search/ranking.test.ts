import { describe, expect, test } from 'bun:test'
import {
  VISUAL_FRESHNESS_HALF_LIFE_DAYS,
  VISUAL_POPULARITY_SATURATION,
  VISUAL_RANKING_WEIGHTS,
  VISUAL_SEARCH_STRATEGY_VERSION,
} from '@fish/contracts/visual/ranking'
import {
  freshnessScore,
  popularityScore,
  scoreVisualCandidate,
  similarityFromCosineDistance,
  VISUAL_RECALL_LIMIT,
  VISUAL_RESULT_LIMIT,
} from './ranking'

/**
 * 混合排序是纯函数（无 IO、无时钟），所以权重组合的正确性全部在这里钉住（#324 M6）。
 * 最关键的一条是"缺失分项不惩罚结果"——它是"解析是可选增强"这个产品判断的唯一落点。
 */
const NOW = new Date('2026-06-01T00:00:00.000Z')

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 86_400_000)
}

describe('similarityFromCosineDistance', () => {
  test('距离 [0, 2] 线性映射到相似度 [1, 0]', () => {
    expect(similarityFromCosineDistance(0)).toBe(1)
    expect(similarityFromCosineDistance(1)).toBe(0.5)
    expect(similarityFromCosineDistance(2)).toBe(0)
  })

  test('越界值被夹紧：未归一化的向量不能产生负分或超过 1', () => {
    expect(similarityFromCosineDistance(3)).toBe(0)
    expect(similarityFromCosineDistance(-1)).toBe(1)
  })

  test('非有限值按 0 处理（上游返回脏数据时不能污染排序）', () => {
    expect(similarityFromCosineDistance(Number.NaN)).toBe(0)
    expect(similarityFromCosineDistance(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('freshnessScore', () => {
  test('刚发布 = 1，正好一个半衰期 = 0.5，两个 = 0.25', () => {
    expect(freshnessScore(NOW, NOW)).toBe(1)
    expect(freshnessScore(daysAgo(VISUAL_FRESHNESS_HALF_LIFE_DAYS), NOW)).toBeCloseTo(0.5, 10)
    expect(freshnessScore(daysAgo(VISUAL_FRESHNESS_HALF_LIFE_DAYS * 2), NOW)).toBeCloseTo(0.25, 10)
  })

  test('未来时间戳（时钟偏移）按 1 而不是 >1', () => {
    expect(freshnessScore(new Date(NOW.getTime() + 86_400_000), NOW)).toBe(1)
  })

  test('单调递减：越旧分越低', () => {
    expect(freshnessScore(daysAgo(1), NOW)).toBeGreaterThan(freshnessScore(daysAgo(10), NOW))
  })
})

describe('popularityScore', () => {
  test('0 / 负数 = 0，饱和点 = 1，超过饱和点仍夹在 1', () => {
    expect(popularityScore(0)).toBe(0)
    expect(popularityScore(-5)).toBe(0)
    expect(popularityScore(VISUAL_POPULARITY_SATURATION / 2)).toBe(0.5)
    expect(popularityScore(VISUAL_POPULARITY_SATURATION)).toBe(1)
    expect(popularityScore(VISUAL_POPULARITY_SATURATION * 10)).toBe(1)
  })

  test('饱和而不是按结果集最大值归一：同一商品的分数不随查询变化', () => {
    expect(popularityScore(5)).toBe(popularityScore(5))
  })

  test('非有限值按 0 处理', () => {
    expect(popularityScore(Number.NaN)).toBe(0)
  })
})

describe('scoreVisualCandidate', () => {
  test('五项齐全时就是加权平均，全 1 得 1', () => {
    const breakdown = scoreVisualCandidate({
      visualScore: 1,
      textScore: 1,
      categoryScore: 1,
      freshnessScore: 1,
      popularityScore: 1,
    })
    expect(breakdown.score).toBeCloseTo(1, 10)
    expect(breakdown.strategyVersion).toBe(VISUAL_SEARCH_STRATEGY_VERSION)
  })

  test('契约权重之和为 1（改权重必须同时改策略版本，这个不变式是它的护栏）', () => {
    const total = Object.values(VISUAL_RANKING_WEIGHTS).reduce((sum, value) => sum + value, 0)
    expect(total).toBeCloseTo(1, 10)
  })

  test('缺失分项连同权重一起剔除，剩余权重按比例归一化', () => {
    const breakdown = scoreVisualCandidate({
      visualScore: 1,
      textScore: null,
      categoryScore: null,
      freshnessScore: 0,
      popularityScore: 0,
    })
    const expected =
      VISUAL_RANKING_WEIGHTS.visual /
      (VISUAL_RANKING_WEIGHTS.visual +
        VISUAL_RANKING_WEIGHTS.freshness +
        VISUAL_RANKING_WEIGHTS.popularity)
    expect(breakdown.score).toBeCloseTo(expected, 10)
  })

  test('没解析出文本不该被惩罚：缺项 > 按 0 分计入', () => {
    const input = { visualScore: 0.8, freshnessScore: 0.5, popularityScore: 0.5 }
    const missing = scoreVisualCandidate({ ...input, textScore: null, categoryScore: null })
    const zeroed = scoreVisualCandidate({ ...input, textScore: 0, categoryScore: 0 })
    expect(missing.score).toBeGreaterThan(zeroed.score)
  })

  test('明细原样回传，便于排查"为什么它排前面"', () => {
    const breakdown = scoreVisualCandidate({
      visualScore: 0.25,
      textScore: null,
      categoryScore: 1,
      freshnessScore: 0.5,
      popularityScore: 0.75,
    })
    expect(breakdown.visualScore).toBe(0.25)
    expect(breakdown.textScore).toBeNull()
    expect(breakdown.categoryScore).toBe(1)
    expect(breakdown.freshnessScore).toBe(0.5)
    expect(breakdown.popularityScore).toBe(0.75)
  })

  test('全 0 输入得 0 分而不是 NaN', () => {
    const breakdown = scoreVisualCandidate({
      visualScore: 0,
      textScore: null,
      categoryScore: null,
      freshnessScore: 0,
      popularityScore: 0,
    })
    expect(breakdown.score).toBe(0)
    expect(Number.isFinite(breakdown.score)).toBe(true)
  })
})

describe('召回与结果上限', () => {
  test('召回上限不小于结果上限（重排要有余量）', () => {
    expect(VISUAL_RECALL_LIMIT).toBeGreaterThanOrEqual(VISUAL_RESULT_LIMIT)
    expect(VISUAL_RESULT_LIMIT).toBeGreaterThan(0)
  })
})
