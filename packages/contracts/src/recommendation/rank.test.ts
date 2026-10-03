import { describe, expect, test } from 'bun:test'
import { INTEREST_ACTION_WEIGHTS } from './interest'
import {
  clamp01,
  composeRecommendationStrategyVersion,
  RANK_FEATURE_KEYS,
  RANK_FEATURE_WEIGHTS,
  RANK_HIDDEN_EVENT_TYPES,
  RANK_NEGATIVE_FEEDBACK_EVENT_TYPES,
  RANK_NEGATIVE_FEEDBACK_WEIGHTS,
  RANK_POSITIVE_WEIGHT_SUM,
  RANK_STRATEGY_VERSION,
  RANK_WISH_SCORE_MAX,
  type RankFeatureKey,
  RankFeatureKeySchema,
  RankScoreBreakdownSchema,
  RECOMMENDATION_SNAPSHOT_MAX_ITEMS,
  RECOMMENDATION_STRATEGY_VERSION_RULE,
  RECOMMENDATION_STRATEGY_VERSION_SEPARATOR,
  RERANK_CATEGORY_MAX_IN_WINDOW,
  RERANK_CATEGORY_WINDOW,
  RERANK_EXPLORE_MIN_PER_WINDOW,
  RERANK_EXPLORE_WINDOW,
  RERANK_RELAXATION_ORDER,
  RerankConstraintSchema,
  saturatingRatio,
} from './rank'
import { RECOMMENDATION_STRATEGY_VERSION_NONE, RecommendationFeedQuerySchema } from './schema'

/**
 * R4 排序契约的单测（#323 R4）。
 *
 * 这里只测**常量之间的关系**（权重表与特征键是否同构、正权重和是不是 1、重排参数之间是否自洽）
 * 与**纯函数的边界**。逐字重复 `0.35` 这类数字没有保护价值；有保护价值的是"加一项特征时上界不会
 * 悄悄漂移""探索配额能不能在窗口里实现"这类自洽性。
 */

describe('composeRecommendationStrategyVersion', () => {
  test('按 `+` 拼装，且 R4 的四段复合串装得进 varchar(64)', () => {
    const composed = composeRecommendationStrategyVersion([
      RECOMMENDATION_STRATEGY_VERSION_RULE,
      'interest-v1',
      'recall-v1',
      RANK_STRATEGY_VERSION,
    ])

    expect(composed).toBe('rec-v1-rule+interest-v1+recall-v1+rank-v1')
    expect(composed.split(RECOMMENDATION_STRATEGY_VERSION_SEPARATOR)).toHaveLength(4)
    // `recommendation_requests.strategy_version` 是 varchar(64)：超长会在落库时静默截断/报错，
    // 而版本串被截断就再也无法判断"这批结果出自哪一版排序"。
    expect(composed.length).toBeLessThanOrEqual(64)
  })

  test('空数组得到空串而不是抛错（降级路径不走它，但纯函数不该有隐藏前提）', () => {
    expect(composeRecommendationStrategyVersion([])).toBe('')
  })

  test('降级版本串与复合串不可能相等：`rec-v1-none` 只代表"没跑召回排序"', () => {
    const composed = composeRecommendationStrategyVersion([
      RECOMMENDATION_STRATEGY_VERSION_RULE,
      'interest-v1',
      'recall-v1',
      RANK_STRATEGY_VERSION,
    ])
    expect(composed).not.toBe(RECOMMENDATION_STRATEGY_VERSION_NONE)
    expect(composed.startsWith(RECOMMENDATION_STRATEGY_VERSION_RULE)).toBe(true)
  })
})

describe('权重表', () => {
  test('正权重和恰好 1.00 ⇒ `rankScore` 上界确定，不随特征数漂移', () => {
    expect(RANK_POSITIVE_WEIGHT_SUM).toBeCloseTo(1, 12)
  })

  test('至少有一项负权重：全是正权重时"惩罚"就没法表达', () => {
    const negative = RANK_FEATURE_KEYS.filter((key) => RANK_FEATURE_WEIGHTS[key] < 0)
    expect(negative.length).toBeGreaterThan(0)
  })

  test('特征键集合与权重表键集合同构（漏一个键的两边都编译不过，但集合要显式钉住）', () => {
    // `Object.keys` 的类型是 `string[]`，这里断言的是"键集合同构"，把转写标成特征键类型即可。
    const weightKeys = Object.keys(RANK_FEATURE_WEIGHTS).sort() as RankFeatureKey[]
    expect([...RANK_FEATURE_KEYS].sort()).toEqual(weightKeys)
    expect(new Set(RANK_FEATURE_KEYS).size).toBe(RANK_FEATURE_KEYS.length)
  })

  test('`RankScoreBreakdownSchema` 的键集合 = 特征键 + `missing`', () => {
    const shapeKeys = Object.keys(RankScoreBreakdownSchema.shape)
    expect(shapeKeys.sort()).toEqual([...RANK_FEATURE_KEYS, 'missing'].sort())
    expect(RankFeatureKeySchema.options).toEqual([...RANK_FEATURE_KEYS])
  })
})

describe('saturatingRatio / clamp01', () => {
  test('saturatingRatio 在半饱和点取 0.5，且随 value 单调上升、恒 < 1', () => {
    expect(saturatingRatio(2, 2)).toBeCloseTo(0.5, 12)
    expect(saturatingRatio(4, 2)).toBeGreaterThan(saturatingRatio(2, 2))
    expect(saturatingRatio(1_000, 2)).toBeLessThan(1)
    // 非法/负值一律 0：这些只可能来自上游查询异常，让 NaN 传播进排序会让比较函数全返回 false。
    expect(saturatingRatio(Number.NaN, 2)).toBe(0)
    expect(saturatingRatio(-3, 2)).toBe(0)
    expect(saturatingRatio(Number.POSITIVE_INFINITY, 2)).toBe(0)
    expect(saturatingRatio(0, 2)).toBe(0)
  })

  test('clamp01 截到 [0, 1]，负数与 NaN 归 0、>1 归 1', () => {
    expect(clamp01(-1)).toBe(0)
    expect(clamp01(0)).toBe(0)
    expect(clamp01(0.42)).toBeCloseTo(0.42, 12)
    expect(clamp01(1)).toBe(1)
    expect(clamp01(1.5)).toBe(1)
    expect(clamp01(Number.NaN)).toBe(0)
  })

  test('`RANK_WISH_SCORE_MAX` 与 matches 表的 CHECK 上界一致（100）', () => {
    expect(RANK_WISH_SCORE_MAX).toBe(100)
  })
})

describe('负反馈权重表', () => {
  test('权重取 `|INTEREST_ACTION_WEIGHTS|`：同一份"行为有多负"只在画像里定义一次', () => {
    for (const eventType of RANK_NEGATIVE_FEEDBACK_EVENT_TYPES) {
      expect(RANK_NEGATIVE_FEEDBACK_WEIGHTS[eventType]).toBe(
        Math.abs(INTEREST_ACTION_WEIGHTS[eventType]),
      )
    }
  })

  test('强度顺序 HIDE > UNFAVORITE > QUICK_SKIP：主动划走比"快速划过"更该被惩罚', () => {
    const { HIDE, UNFAVORITE, QUICK_SKIP } = RANK_NEGATIVE_FEEDBACK_WEIGHTS
    expect(HIDE).toBeGreaterThan(UNFAVORITE)
    expect(UNFAVORITE).toBeGreaterThan(QUICK_SKIP)
  })

  test('硬排除事件类型是软惩罚事件类型的子集，且只有 HIDE', () => {
    expect([...RANK_HIDDEN_EVENT_TYPES]).toEqual(['HIDE'])
    for (const eventType of RANK_HIDDEN_EVENT_TYPES) {
      expect(RANK_NEGATIVE_FEEDBACK_EVENT_TYPES).toContain(eventType)
    }
    // IMPRESSION 不是负反馈（那是"重复"，由 repeatedExposure 单独处理）。
    expect(RANK_NEGATIVE_FEEDBACK_EVENT_TYPES).not.toContain('IMPRESSION')
  })
})

describe('重排参数自洽性', () => {
  test('松弛顺序是约束集合的排列（少一个约束就永远让不掉，死循环）', () => {
    expect([...RERANK_RELAXATION_ORDER].sort()).toEqual([...RerankConstraintSchema.options].sort())
    expect(new Set(RERANK_RELAXATION_ORDER).size).toBe(RERANK_RELAXATION_ORDER.length)
  })

  test('类目窗能实现"窗口内 ≤2"：上界小于窗口长度', () => {
    expect(RERANK_CATEGORY_MAX_IN_WINDOW).toBeLessThan(RERANK_CATEGORY_WINDOW)
    expect(RERANK_CATEGORY_MAX_IN_WINDOW).toBeGreaterThan(0)
  })

  test('探索配额是可达的：窗口长度整除后至少能放 1 条', () => {
    expect(RERANK_EXPLORE_MIN_PER_WINDOW).toBeGreaterThan(0)
    expect(RERANK_EXPLORE_MIN_PER_WINDOW).toBeLessThanOrEqual(RERANK_EXPLORE_WINDOW)
  })
})

describe('RankScoreBreakdownSchema', () => {
  const contribution = { normalized: 0.5, weight: 0.2, contribution: 0.1 }
  const valid = {
    semantic: contribution,
    wish: contribution,
    category: contribution,
    freshness: contribution,
    popularity: contribution,
    repeatedExposure: contribution,
    negativeFeedback: contribution,
    missing: [],
  }

  test('七个键 + missing 全在时通过', () => {
    expect(RankScoreBreakdownSchema.safeParse(valid).success).toBe(true)
  })

  test('缺键被拒：明细形状必须固定，否则离线评估无法按 key 对齐比较', () => {
    const { semantic: _dropped, ...withoutSemantic } = valid
    expect(RankScoreBreakdownSchema.safeParse(withoutSemantic).success).toBe(false)
  })

  test('未知键被拒（strictObject）：多出来的键只会来自版本不一致', () => {
    expect(
      RankScoreBreakdownSchema.safeParse({ ...valid, priceAffinity: contribution }).success,
    ).toBe(false)
  })

  test('`normalized` 越界被拒：归一化的口径就是 [0, 1]', () => {
    expect(
      RankScoreBreakdownSchema.safeParse({
        ...valid,
        semantic: { normalized: 1.2, weight: 0.35, contribution: 0.42 },
      }).success,
    ).toBe(false)
    expect(
      RankScoreBreakdownSchema.safeParse({
        ...valid,
        semantic: { normalized: -0.1, weight: 0.35, contribution: -0.035 },
      }).success,
    ).toBe(false)
  })

  test('`missing` 里只允许特征键：写进别的字符串说明上游在编造键名', () => {
    expect(RankScoreBreakdownSchema.safeParse({ ...valid, missing: ['nope'] }).success).toBe(false)
    expect(RankScoreBreakdownSchema.safeParse({ ...valid, missing: ['semantic'] }).success).toBe(
      true,
    )
  })
})

describe('快照上限', () => {
  test('一次请求的上限远大于单页上限，且被单页上限整除后仍有余量', () => {
    const maxLimit = RecommendationFeedQuerySchema.parse({}).limit
    expect(RECOMMENDATION_SNAPSHOT_MAX_ITEMS).toBeGreaterThan(maxLimit)
    expect(RECOMMENDATION_SNAPSHOT_MAX_ITEMS % maxLimit).toBe(0)
  })
})
