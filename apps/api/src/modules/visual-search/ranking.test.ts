import { describe, expect, test } from 'bun:test'
import type { ListingCard, ListingCondition } from '@fish/contracts/listings/schema'
import {
  VISUAL_CONDITION_RANK,
  VISUAL_FRESHNESS_HALF_LIFE_DAYS,
  VISUAL_POPULARITY_SATURATION,
  VISUAL_RANKING_WEIGHTS,
  VISUAL_SEARCH_STRATEGY_VERSION,
  type VisualScoreBreakdown,
} from '@fish/contracts/visual/ranking'
import { VISUAL_SEARCH_SORTS, type VisualSearchSort } from '@fish/contracts/visual/schema'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import {
  freshnessScore,
  orderVisualCandidates,
  popularityScore,
  scoreVisualCandidate,
  similarityFromCosineDistance,
  VISUAL_RECALL_LIMIT,
  VISUAL_RESULT_LIMIT,
  type VisualScoredCandidate,
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

/** 排序测试的卡片夹具：只关心排序真正读到的列，其余用合法默认值填满。 */
function makeCard(seq: number, overrides: Partial<ListingCard> = {}): ListingCard {
  return {
    // 公开 id 必须是规范 UUIDv7 编码（`encodePublicId` 会当场拒绝 v4），
    // 尾号递增保证 `localeCompare` 序与 seq 序一致，兜底断言才可读。
    id: encodePublicId(
      PUBLIC_ID_PREFIX.listing,
      `0197f0a1-0000-7000-8000-${seq.toString().padStart(12, '0')}`,
    ),
    title: `商品-${seq}`,
    priceCents: 1000,
    category: 'BOOKS',
    condition: 'GOOD',
    status: 'ACTIVE',
    urgent: false,
    negotiable: false,
    free: false,
    coverUrl: null,
    createdAt: '2026-05-01T00:00:00.000Z',
    moderationStatus: null,
    // 想要数（已建会话的买家数）：卡片契约的必填字段，夹具给 0（排序不读它）。
    wants: 0,
    ...overrides,
  }
}

function scoreBreakdown(score: number): VisualScoreBreakdown {
  return {
    score,
    visualScore: score,
    textScore: null,
    categoryScore: null,
    freshnessScore: 1,
    popularityScore: 1,
    strategyVersion: VISUAL_SEARCH_STRATEGY_VERSION,
  }
}

/**
 * 五档排序（#324 M6）的表驱动夹具。
 *
 * 五档的期望顺序**故意互不相同**：某一档的排序键若写错/漏了 case，会退回统一兜底
 * （score 降序），而 `relevance` 的期望恰好就是 score 降序——只有每档期望各不相同，
 * "写错一档"才会被断言抓住，而不是恰好通过。
 *
 * `title` 不参与任何排序键，这里借它当断言的可读标签，省掉一张 id→标签对照表。
 */
type SortFixture = {
  label: string
  score: number
  favoriteCount: number
  createdAt: string
  priceCents: number
  condition: ListingCondition
}

const SORT_FIXTURES: SortFixture[] = [
  {
    label: 'a',
    score: 0.9,
    favoriteCount: 1,
    createdAt: '2026-05-01T00:00:00.000Z',
    priceCents: 3000,
    condition: 'FAIR',
  },
  {
    label: 'b',
    score: 0.5,
    favoriteCount: 5,
    createdAt: '2026-05-20T00:00:00.000Z',
    priceCents: 1000,
    condition: 'LIKE_NEW',
  },
  {
    label: 'c',
    score: 0.7,
    favoriteCount: 3,
    createdAt: '2026-05-10T00:00:00.000Z',
    priceCents: 2000,
    condition: 'NEW',
  },
  {
    label: 'd',
    score: 0.3,
    favoriteCount: 5,
    createdAt: '2026-04-01T00:00:00.000Z',
    priceCents: 500,
    condition: 'GOOD',
  },
]

const SORT_EXPECTATIONS: Array<{ sort: VisualSearchSort; expected: string[] }> = [
  // relevance 的排序键就是统一兜底：混合分降序。
  { sort: 'relevance', expected: ['a', 'c', 'b', 'd'] },
  // b/d 想要数并列（5），由兜底的分数分出先后。
  { sort: 'popular', expected: ['b', 'd', 'c', 'a'] },
  { sort: 'newest', expected: ['b', 'c', 'a', 'd'] },
  { sort: 'price_asc', expected: ['d', 'b', 'c', 'a'] },
  // NEW(0) → LIKE_NEW(1) → GOOD(2) → FAIR(3)。
  { sort: 'condition', expected: ['c', 'b', 'd', 'a'] },
]

function sortFixtureCandidates(): VisualScoredCandidate[] {
  return SORT_FIXTURES.map((fixture, index) => ({
    card: makeCard(index + 1, {
      title: fixture.label,
      createdAt: fixture.createdAt,
      priceCents: fixture.priceCents,
      condition: fixture.condition,
    }),
    ranking: scoreBreakdown(fixture.score),
    favoriteCount: fixture.favoriteCount,
  }))
}

function labelsOf(candidates: readonly VisualScoredCandidate[]): string[] {
  return candidates.map((entry) => entry.card.title)
}

describe('orderVisualCandidates', () => {
  for (const { sort, expected } of SORT_EXPECTATIONS) {
    test(`${sort} 档按自己的排序键定序`, () => {
      expect(labelsOf(orderVisualCandidates(sortFixtureCandidates(), sort))).toEqual(expected)
    })
  }

  test('表驱动覆盖契约里的全部排序档（新增一档必须同时补用例）', () => {
    expect(SORT_EXPECTATIONS.map((entry) => entry.sort).sort()).toEqual(
      [...VISUAL_SEARCH_SORTS].sort(),
    )
  })

  test('成色序常量与契约一致（NEW 最前，FAIR 最后）', () => {
    expect(VISUAL_CONDITION_RANK).toEqual({ NEW: 0, LIKE_NEW: 1, GOOD: 2, FAIR: 3 })
  })

  test('全部排序键并列时输出确定：入参乱序也给同一结果，且落到 id 升序', () => {
    const tied = [1, 2, 3].map((seq) => ({
      card: makeCard(seq),
      ranking: scoreBreakdown(0.5),
      favoriteCount: 7,
    }))

    for (const { sort } of SORT_EXPECTATIONS) {
      const forward = orderVisualCandidates(tied, sort)
      const reversed = orderVisualCandidates([...tied].reverse(), sort)
      expect(labelsOf(forward)).toEqual(['商品-1', '商品-2', '商品-3'])
      expect(labelsOf(reversed)).toEqual(labelsOf(forward))
    }
  })

  test('混合分并列时先看图片相似度：有图片证据的排在纯文本命中之前', () => {
    // 纯文本命中的候选 visualScore = 0（M6 之前的既有口径），同分时必须排在后面。
    // 少了这一层，同分排序会落到公开 id 上，而公开 id 是随机的——同一个查询两次会给出不同顺序。
    const withVisualScore = (seq: number, visualScore: number): VisualScoredCandidate => ({
      card: makeCard(seq),
      ranking: { ...scoreBreakdown(0.5), visualScore },
      favoriteCount: 7,
    })

    const tied = [withVisualScore(1, 0), withVisualScore(2, 0.9), withVisualScore(3, 0.4)]

    for (const { sort } of SORT_EXPECTATIONS) {
      expect(labelsOf(orderVisualCandidates(tied, sort))).toEqual(['商品-2', '商品-3', '商品-1'])
      expect(labelsOf(orderVisualCandidates([...tied].reverse(), sort))).toEqual([
        '商品-2',
        '商品-3',
        '商品-1',
      ])
    }
  })

  test('不修改入参：返回新数组，入参顺序与元素内容都不变', () => {
    const input = sortFixtureCandidates()
    const snapshot = input.map((entry) => ({
      id: entry.card.id,
      favoriteCount: entry.favoriteCount,
      score: entry.ranking.score,
    }))

    const output = orderVisualCandidates(input, 'price_asc')

    expect(output).not.toBe(input)
    expect(output).toHaveLength(input.length)
    expect(labelsOf(input)).toEqual(['a', 'b', 'c', 'd'])
    expect(
      input.map((entry) => ({
        id: entry.card.id,
        favoriteCount: entry.favoriteCount,
        score: entry.ranking.score,
      })),
    ).toEqual(snapshot)
  })
})
