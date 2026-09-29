import { describe, expect, test } from 'bun:test'
import {
  RecommendationEventTypeSchema,
  RecommendationSourceSchema,
} from '@fish/contracts/recommendation/schema'
import {
  combineInterestVectors,
  POPULARITY_ACTION_HALF_LIFE_MS,
  POPULARITY_ACTION_TYPES,
  POPULARITY_ACTION_WEIGHTS,
  POPULARITY_LISTING_AGE_HALF_LIFE_MS,
  POPULARITY_WINDOW_DAYS,
  popularityWindowStart,
  RECALL_CHANNEL_LIMITS,
  RECALL_CHANNEL_PRIORITY,
  RECALL_CHANNELS,
  RECALL_EXPLORE_MIX,
  RECALL_FRESHNESS_HALF_LIFE_MS,
  RECALL_INTEREST_MIX,
  RECALL_MAX_CANDIDATES,
  RECALL_MAX_SOURCES_PER_CANDIDATE,
  RECALL_SESSION_CATEGORY_TOP_N,
  RECALL_STRATEGY_VERSION,
} from './recall'

/**
 * 召回常量与纯函数的单测（#323 R3）。
 *
 * 这里只测**有分支的纯逻辑**（兴趣合成）与**常量之间的算术关系**（配额能否凑够候选池、
 * 优先级是不是通道的全排列、热度权重表覆盖哪些事件）。逐字重复常量值的断言没有价值——
 * 它们改一次测试就要跟着改一次，却不提供任何保护；有保护的是"这些数字放在一起是否自洽"。
 */

const DAY_MS = 24 * 60 * 60 * 1000

describe('combineInterestVectors', () => {
  test('两路都没有 → null（绝不返回零向量）', () => {
    expect(combineInterestVectors({ session: null, longTerm: null })).toBeNull()
  })

  test('零向量按"没有画像"处理', () => {
    expect(combineInterestVectors({ session: [0, 0], longTerm: null })).toBeNull()
    expect(combineInterestVectors({ session: null, longTerm: [0, 0] })).toBeNull()
    // 两路都是零向量：归一化后都为 null，等同于"两路都没有"。
    expect(combineInterestVectors({ session: [0, 0], longTerm: [0, 0] })).toBeNull()
  })

  test('只有一路时直接用那一路（不因为缺另一路而缩小模长）', () => {
    // 非单位向量输入也要被归一化：模长不该进入 cosine 的分子。
    expect(combineInterestVectors({ session: [3, 4], longTerm: null })).toEqual([0.6, 0.8])
    expect(combineInterestVectors({ session: null, longTerm: [0, 5] })).toEqual([0, 1])
  })

  test('两路都有时按 α/β 合成并再次归一化', () => {
    const combined = combineInterestVectors({ session: [1, 0], longTerm: [0, 1] })
    expect(combined).not.toBeNull()
    const vector = combined as number[]
    // 方向 = (0.7, 0.3)；模长必须回到 1（否则两路都有的用户会被 cosine 放大）。
    expect(vector[0] ?? 0).toBeCloseTo(0.7 / Math.sqrt(0.58), 12)
    expect(vector[1] ?? 0).toBeCloseTo(0.3 / Math.sqrt(0.58), 12)
    const magnitude = Math.hypot(...vector)
    expect(magnitude).toBeCloseTo(1, 12)
    // α/β 的默认值来自契约常量，测试不该把 0.7/0.3 再抄一遍。
    expect(RECALL_INTEREST_MIX.session).toBeGreaterThan(RECALL_INTEREST_MIX.longTerm)
  })

  test('α/β 可覆盖（供 R6 做实验）', () => {
    const vector = combineInterestVectors({
      session: [1, 0],
      longTerm: [0, 1],
      mix: { session: 0, longTerm: 1 },
    })
    // 权重全给长期 → 结果必须等于长期那一路。
    expect(vector?.[0] ?? 0).toBeCloseTo(0, 12)
    expect(vector?.[1] ?? 0).toBeCloseTo(1, 12)
  })

  test('两路维度不一致直接抛错，不静默截断', () => {
    expect(() => combineInterestVectors({ session: [1, 0, 0], longTerm: [1, 0] })).toThrow(
      '兴趣合成：两路画像维度不一致',
    )
  })

  test('空数组抛错（上游 model/维度过滤漏了才会出现）', () => {
    expect(() => combineInterestVectors({ session: [], longTerm: null })).toThrow(
      '兴趣合成：session 向量为空数组',
    )
    expect(() => combineInterestVectors({ session: null, longTerm: [] })).toThrow(
      '兴趣合成：longTerm 向量为空数组',
    )
  })
})

describe('召回常量自洽性', () => {
  test('策略版本号存在且可被 profile 消费方比较', () => {
    expect(RECALL_STRATEGY_VERSION).toBe('recall-v1')
  })

  test('每路配额都定义了，且六路配额之和不超过候选池上限', () => {
    const quotaSum = RECALL_CHANNELS.reduce(
      (sum, channel) => sum + RECALL_CHANNEL_LIMITS[channel],
      0,
    )
    // 单路配额是**去重前**的预算，池上限是**去重后**的硬顶：配额之和必须装得进池子，
    // 否则会有通道的配额被池上限悄悄吃掉（"这一路可独立运行"就成了空话）。
    expect(quotaSum).toBeLessThanOrEqual(RECALL_MAX_CANDIDATES)
    // 池上限也不能小于单路最大配额，否则单路取数就会先被截断。
    expect(RECALL_MAX_CANDIDATES).toBeGreaterThanOrEqual(
      Math.max(...RECALL_CHANNELS.map((channel) => RECALL_CHANNEL_LIMITS[channel])),
    )
    // 单路配额必须为正：0 会让"这一路可独立运行"变成"这一路永远空"。
    for (const channel of RECALL_CHANNELS) {
      expect(RECALL_CHANNEL_LIMITS[channel]).toBeGreaterThan(0)
    }
  })

  test('优先级是通道的全排列（漏一个通道会让它永远排在最后）', () => {
    expect([...RECALL_CHANNEL_PRIORITY].sort()).toEqual([...RECALL_CHANNELS].sort())
    expect(new Set(RECALL_CHANNEL_PRIORITY).size).toBe(RECALL_CHANNELS.length)
    expect(RECALL_MAX_SOURCES_PER_CANDIDATE).toBe(RECALL_CHANNELS.length)
  })

  test('每个通道都是合法的 RecommendationSource（对外归因标签与契约枚举同源）', () => {
    for (const channel of RECALL_CHANNELS) {
      expect(RecommendationSourceSchema.options).toContain(channel)
    }
  })

  test('探索配额之和等于该路配额，且三个子块都非零', () => {
    const exploreMixSum =
      RECALL_EXPLORE_MIX.newListing + RECALL_EXPLORE_MIX.newSeller + RECALL_EXPLORE_MIX.coldCategory
    expect(exploreMixSum).toBe(RECALL_CHANNEL_LIMITS.explore)
    expect(RECALL_EXPLORE_MIX.newListing).toBeGreaterThan(0)
    expect(RECALL_EXPLORE_MIX.newSeller).toBeGreaterThan(0)
    expect(RECALL_EXPLORE_MIX.coldCategory).toBeGreaterThan(0)
  })

  test('热度权重只覆盖有正向信号的行为，弱信号/负反馈为 0', () => {
    const eventTypes = RecommendationEventTypeSchema.options
    const positive = eventTypes.filter((eventType) => POPULARITY_ACTION_WEIGHTS[eventType] > 0)
    expect([...positive].sort()).toEqual([...POPULARITY_ACTION_TYPES].sort())
    for (const eventType of ['IMPRESSION', 'QUICK_SKIP', 'UNFAVORITE', 'HIDE'] as const) {
      expect(POPULARITY_ACTION_WEIGHTS[eventType]).toBe(0)
    }
    // 权重必须单调地反映意图强度：成交 > 发起交易 > 发起聊天 > 收藏 > 详情。
    expect(POPULARITY_ACTION_WEIGHTS.PURCHASE).toBeGreaterThan(
      POPULARITY_ACTION_WEIGHTS.TRANSACTION_START,
    )
    expect(POPULARITY_ACTION_WEIGHTS.TRANSACTION_START).toBeGreaterThan(
      POPULARITY_ACTION_WEIGHTS.CHAT_START,
    )
    expect(POPULARITY_ACTION_WEIGHTS.CHAT_START).toBeGreaterThan(POPULARITY_ACTION_WEIGHTS.FAVORITE)
    expect(POPULARITY_ACTION_WEIGHTS.FAVORITE).toBeGreaterThan(
      POPULARITY_ACTION_WEIGHTS.DETAIL_VIEW,
    )
  })

  test('热度窗口与两个半衰期的量级关系', () => {
    const now = new Date('2026-01-15T00:00:00.000Z')
    expect(popularityWindowStart(now).toISOString()).toBe(
      new Date(now.getTime() - POPULARITY_WINDOW_DAYS * DAY_MS).toISOString(),
    )
    // 行为衰减必须比商品年龄衰减快：热度要反映"最近在火"，而不是"这件商品不老"。
    expect(POPULARITY_ACTION_HALF_LIFE_MS).toBeLessThan(POPULARITY_LISTING_AGE_HALF_LIFE_MS)
    // freshness 与 Popular 的商品年龄惩罚必须是同一个量，否则同一件商品有两个新鲜度。
    expect(RECALL_FRESHNESS_HALF_LIFE_MS).toBe(POPULARITY_LISTING_AGE_HALF_LIFE_MS)
  })

  test('会话类目取前 N 个，且 N 不超过类目总数', () => {
    expect(RECALL_SESSION_CATEGORY_TOP_N).toBeGreaterThan(0)
    expect(RECALL_SESSION_CATEGORY_TOP_N).toBeLessThanOrEqual(8)
  })
})
