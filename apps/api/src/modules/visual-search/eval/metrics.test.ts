import { describe, expect, test } from 'bun:test'
import {
  emptyResultRate,
  latencyPercentile,
  mrr,
  ndcgAtK,
  recallAtK,
  topKRelevanceRate,
} from './metrics'

/**
 * 每个公式都用**手算过的小样例**钉死，算式写在注释里。
 *
 * 这些函数是 M9 报告里每一个数字的来源，所以测试的目标不是"跑通"而是"换个实现也逃不掉"：
 * 只要公式被改动（换分母、去折扣、改插值方式），下面的数字就会变，测试立刻红。
 */

// ---------------------------------------------------------------------------
// 共用样例（与 rank-compare 的"小样例 + 手算"同一取舍）
//
//   ranked  = [A, B, C, D, E]
//   relevance = { A: 0, B: 2, C: 1, D: 0, E: 1 }
//
//   相关项（relevance ≥ 1）= { B, C, E }，共 3 个。
// ---------------------------------------------------------------------------

const RANKED = ['A', 'B', 'C', 'D', 'E'] as const
const RELEVANCE: Record<string, 0 | 1 | 2> = { A: 0, B: 2, C: 1, D: 0, E: 1 }

describe('recallAtK', () => {
  test('分母是标注的相关项总数（B/C/E 共 3 个）', () => {
    // Top-1 = [A]            → 命中 0 个 → 0/3 = 0
    expect(recallAtK(RANKED, RELEVANCE, 1)).toBe(0)
    // Top-2 = [A,B]          → 命中 B   → 1/3
    expect(recallAtK(RANKED, RELEVANCE, 2)).toBeCloseTo(1 / 3, 12)
    // Top-3 = [A,B,C]        → 命中 B,C → 2/3
    expect(recallAtK(RANKED, RELEVANCE, 3)).toBeCloseTo(2 / 3, 12)
    // Top-5 = [A,B,C,D,E]    → 命中 B,C,E → 3/3 = 1
    expect(recallAtK(RANKED, RELEVANCE, 5)).toBe(1)
  })

  test('k > ranked.length 等价于对整个列表求召回，不越界也不补零', () => {
    expect(recallAtK(RANKED, RELEVANCE, 1000)).toBe(1)
  })

  test('k ≤ 0 或非有限 → 0', () => {
    expect(recallAtK(RANKED, RELEVANCE, 0)).toBe(0)
    expect(recallAtK(RANKED, RELEVANCE, -3)).toBe(0)
    expect(recallAtK(RANKED, RELEVANCE, Number.NaN)).toBe(0)
  })

  test('空 ranked → 0', () => {
    expect(recallAtK([], RELEVANCE, 5)).toBe(0)
  })

  test('没有任何相关项 → 0（不是 NaN）', () => {
    // 分母为 0 的退化情形必须定义清楚。
    expect(recallAtK(RANKED, { A: 0, D: 0 }, 5)).toBe(0)
    expect(recallAtK(RANKED, {}, 5)).toBe(0)
  })

  test('relevance 里没有的 id 按 0 处理；重复 id 只算一次', () => {
    // X 不在 relevance 里 → 不算相关。
    expect(recallAtK(['X', 'B'], RELEVANCE, 2)).toBeCloseTo(1 / 3, 12)
    // 同一个相关项重复出现不能刷高召回。
    expect(recallAtK(['B', 'B', 'B'], RELEVANCE, 3)).toBeCloseTo(1 / 3, 12)
  })
})

describe('mrr', () => {
  test('首个相关项的名次倒数', () => {
    // ranked = [A, B, ...]，B 是首个相关项（relevance 2），名次 2 → 1/2。
    expect(mrr(RANKED, RELEVANCE)).toBe(0.5)
    expect(mrr(['B', 'C', 'E'], RELEVANCE)).toBe(1)
    expect(mrr(['C'], RELEVANCE)).toBe(1)
  })

  test('只看第一个相关项，不做 Top-K 截断', () => {
    // B 在第 3 名 → 1/3；首个相关项是 C（第 3 名）→ 1/3；D 之后才出现相关项 → 1/4。
    expect(mrr(['A', 'D', 'B'], RELEVANCE)).toBeCloseTo(1 / 3, 12)
    expect(mrr(['A', 'D', 'C', 'B'], RELEVANCE)).toBeCloseTo(1 / 3, 12)
    expect(mrr(['A', 'D', 'E', 'B'], RELEVANCE)).toBeCloseTo(1 / 3, 12)
    expect(mrr(['A', 'D', 'C', 'E', 'B'], RELEVANCE)).toBeCloseTo(1 / 3, 12)
    // 只保留一个相关项（B）时才能干净地看到 1/4。
    expect(mrr(['A', 'D', 'C', 'E', 'B'], { B: 2 })).toBeCloseTo(1 / 5, 12)
    expect(mrr(['A', 'D', 'E', 'C', 'B'], { B: 2 })).toBeCloseTo(1 / 5, 12)
    expect(mrr(['A', 'D', 'C', 'B'], { B: 2 })).toBeCloseTo(1 / 4, 12)
  })

  test('没有相关项 → 0；空 ranked → 0', () => {
    expect(mrr(['A', 'D'], RELEVANCE)).toBe(0)
    expect(mrr([], RELEVANCE)).toBe(0)
    expect(mrr(['A'], {})).toBe(0)
  })
})

describe('ndcgAtK', () => {
  test('k = 3：DCG 2.5 / IDCG 3.0', () => {
    // DCG@3  = (2^0-1)/log2(2) + (2^2-1)/log2(3) + (2^1-1)/log2(4)
    //        = 0 + 3/1.5849625007 + 1/2 = 1.8927892607 + 0.5 = 2.3927892607
    // IDCG@3 = 3/log2(2) + 1/log2(3) + 1/log2(4) = 3 + 0.6309297536 + 0.5 = 4.1309297536
    //          （理想排序把 rel=2 放第 1，两个 rel=1 放第 2、3）
    expect(ndcgAtK(RANKED, RELEVANCE, 3)).toBeCloseTo(2.3927892607 / 4.1309297536, 9)
  })

  test('k = 5：DCG 2.7796420679 / IDCG 4.1309297536', () => {
    // DCG@5  = 前 4 名同上 + (2^1-1)/log2(6) = 2.3927892607 + 1/2.5849625007
    //        = 2.3927892607 + 0.3868528072 = 2.7796420679
    // IDCG@5 = 前 3 名同上 + 0（只剩 3 个相关项） = 4.1309297536
    expect(ndcgAtK(RANKED, RELEVANCE, 5)).toBeCloseTo(2.7796420679 / 4.1309297536, 9)
    // k 大于候选池时 IDCG 不会因为"缺少位置"而缩小，所以不能到 1。
    expect(ndcgAtK(RANKED, RELEVANCE, 50)).toBeCloseTo(ndcgAtK(RANKED, RELEVANCE, 5), 12)
  })

  test('完美排序 → 1', () => {
    // 理想顺序 B(2), C(1), E(1) → DCG === IDCG。
    expect(ndcgAtK(['B', 'C', 'E'], RELEVANCE, 3)).toBeCloseTo(1, 12)
  })

  test('k = 1：DCG 0 / IDCG 3 = 0', () => {
    // Top-1 是 A（rel 0，增益 0），理想 Top-1 是 B（rel 2，增益 3）。
    expect(ndcgAtK(RANKED, RELEVANCE, 1)).toBe(0)
  })

  test('分级增益生效：把 rel=2 排到第 2 名会掉分', () => {
    // 交换 B 与 C：DCG@3 = 1/log2(2) + 3/log2(3) + 1/log2(4) = 1 + 1.8927892607 + 0.5
    const swapped = ndcgAtK(['C', 'B', 'E'], RELEVANCE, 3)
    expect(swapped).toBeCloseTo((1 + 3 / Math.log2(3) + 0.5) / (3 + 1 / Math.log2(3) + 0.5), 12)
    expect(swapped).toBeLessThan(1)
  })

  test('没有相关项 → 0（IDCG 为 0 时不返回 NaN）', () => {
    expect(ndcgAtK(RANKED, { A: 0, D: 0 }, 5)).toBe(0)
    expect(ndcgAtK(RANKED, {}, 5)).toBe(0)
  })

  test('空 ranked / k ≤ 0 → 0', () => {
    expect(ndcgAtK([], RELEVANCE, 3)).toBe(0)
    expect(ndcgAtK(RANKED, RELEVANCE, 0)).toBe(0)
    expect(ndcgAtK(RANKED, RELEVANCE, -1)).toBe(0)
  })
})

describe('topKRelevanceRate', () => {
  test('分母是"实际返回的位置数"，不是 k', () => {
    // Top-3 = [A,B,C]：相关 B、C → 2/3。
    expect(topKRelevanceRate(RANKED, RELEVANCE, 3)).toBeCloseTo(2 / 3, 12)
    // Top-1 = [A]：0/1 = 0。
    expect(topKRelevanceRate(RANKED, RELEVANCE, 1)).toBe(0)
    // Top-5 = [A,B,C,D,E]：相关 B、C、E → 3/5。
    expect(topKRelevanceRate(RANKED, RELEVANCE, 5)).toBeCloseTo(3 / 5, 12)
  })

  test('k > ranked.length 时分母取 ranked.length', () => {
    // 只有 3 条候选，其中 2 条相关 → 2/3（若拿 k=5 当分母会错算成 2/5）。
    expect(topKRelevanceRate(['A', 'B', 'C'], RELEVANCE, 5)).toBeCloseTo(2 / 3, 12)
  })

  test('空 ranked / k ≤ 0 → 0', () => {
    expect(topKRelevanceRate([], RELEVANCE, 5)).toBe(0)
    expect(topKRelevanceRate(RANKED, RELEVANCE, 0)).toBe(0)
  })
})

describe('emptyResultRate', () => {
  test('空结果数 / 请求数', () => {
    // 5 次请求，其中 2 次返回 0 条 → 2/5。
    expect(
      emptyResultRate([
        { itemCount: 0 },
        { itemCount: 3 },
        { itemCount: 1 },
        { itemCount: 0 },
        { itemCount: 30 },
      ]),
    ).toBeCloseTo(2 / 5, 12)
  })

  test('全部命中 → 0；全部落空 → 1', () => {
    expect(emptyResultRate([{ itemCount: 1 }, { itemCount: 9 }])).toBe(0)
    expect(emptyResultRate([{ itemCount: 0 }, { itemCount: 0 }])).toBe(1)
  })

  test('没有请求 → 0（不是 NaN）', () => {
    expect(emptyResultRate([])).toBe(0)
  })
})

describe('latencyPercentile', () => {
  const SAMPLES = [40, 10, 30, 20] as const

  test('线性插值（numpy.percentile 默认的 linear 定义）', () => {
    // 排序后 [10, 20, 30, 40]。
    // p50: pos = 3 * 0.5 = 1.5 → 20 + (30-20)*0.5 = 25
    expect(latencyPercentile(SAMPLES, 0.5)).toBe(25)
    // p95: pos = 3 * 0.95 = 2.85 → 30 + (40-30)*0.85 = 38.5
    expect(latencyPercentile(SAMPLES, 0.95)).toBeCloseTo(38.5, 12)
    // p0 → 最小值；p1 → 最大值（钳制，不外插）。
    expect(latencyPercentile(SAMPLES, 0)).toBe(10)
    expect(latencyPercentile(SAMPLES, 1)).toBe(40)
  })

  test('输入不要求已排序，且不会被原地排序改动', () => {
    const mutable = [40, 10, 30, 20]
    expect(latencyPercentile(mutable, 0.5)).toBe(25)
    expect(mutable).toEqual([40, 10, 30, 20])
  })

  test('单样本 → 该样本自身（任意 p）', () => {
    expect(latencyPercentile([7], 0.5)).toBe(7)
    expect(latencyPercentile([7], 0.95)).toBe(7)
  })

  test('空数组 → 0；p 非有限 → 0；p 越界被钳制', () => {
    expect(latencyPercentile([], 0.5)).toBe(0)
    expect(latencyPercentile(SAMPLES, Number.NaN)).toBe(0)
    expect(latencyPercentile(SAMPLES, -1)).toBe(10)
    expect(latencyPercentile(SAMPLES, 2)).toBe(40)
  })

  test('两个样本的 p50 落在两者中点（不是上半区）', () => {
    // pos = 1 * 0.5 = 0.5 → 100 + (200-100)*0.5 = 150（取 floor(p*n) 会得到 200）。
    expect(latencyPercentile([100, 200], 0.5)).toBe(150)
  })
})

describe('组合：与分数并列时的排序稳定性无关', () => {
  test('指标只依赖传入顺序，不做二次排序（并列分数的处理在上游 rank 里）', () => {
    // 同一组相关项，名次不同 → 指标必须不同，证明函数没有偷偷按 id 重排。
    expect(mrr(['B', 'A'], RELEVANCE)).toBe(1)
    expect(mrr(['A', 'B'], RELEVANCE)).toBe(0.5)
  })
})
