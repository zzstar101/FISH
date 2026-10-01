import { describe, expect, test } from 'bun:test'
import {
  aggregateInterestVector,
  INTEREST_ACTION_WEIGHTS,
  INTEREST_LONG_TERM_WINDOW_DAYS,
  INTEREST_MIN_ACTION_DECAY,
  INTEREST_ZERO_WEIGHT_EVENT_TYPES,
  type InterestAction,
  interestDecayFactor,
  interestLookbackStart,
} from './interest'
import { RecommendationEventTypeSchema } from './schema'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const SESSION_HALF_LIFE = 30 * 60 * 1000
const LONG_TERM_HALF_LIFE = 14 * DAY

const NOW = new Date('2026-03-01T12:00:00.000Z')

/** 单位方向上的二维/三维测试向量，方便手算点积。 */
const X = [1, 0, 0]
const Y = [0, 1, 0]
const Z = [0, 0, 1]

function action(
  eventType: InterestAction['eventType'],
  vector: readonly number[] | null,
  ageMs = 0,
): InterestAction {
  return { eventType, vector, occurredAt: new Date(NOW.getTime() - ageMs) }
}

function dot(left: readonly number[], right: readonly number[]): number {
  let sum = 0
  for (let index = 0; index < left.length; index += 1) {
    sum += (left[index] ?? 0) * (right[index] ?? 0)
  }
  return sum
}

function norm(vector: readonly number[]): number {
  return Math.sqrt(dot(vector, vector))
}

describe('INTEREST_ACTION_WEIGHTS', () => {
  test('覆盖全部 12 类事件（漏一类会在类型层就报错，这里再钉一次运行期事实）', () => {
    const eventTypes = RecommendationEventTypeSchema.options
    expect(eventTypes).toHaveLength(12)
    for (const eventType of eventTypes) {
      expect(typeof INTEREST_ACTION_WEIGHTS[eventType]).toBe('number')
    }
  })

  test('曝光权重为 0，强正反馈按业务漏斗阶梯递增', () => {
    expect(INTEREST_ACTION_WEIGHTS.IMPRESSION).toBe(0)
    const ladder = [
      'IMAGE_VIEW',
      'DETAIL_VIEW',
      'LONG_VIEW',
      'COMMENT',
      'FAVORITE',
      'CHAT_START',
      'TRANSACTION_START',
      'PURCHASE',
    ] as const
    for (let index = 1; index < ladder.length; index += 1) {
      const previous = ladder[index - 1]
      const current = ladder[index]
      if (previous === undefined || current === undefined) {
        throw new Error('权重阶梯用例：阶梯下标越界')
      }
      expect(INTEREST_ACTION_WEIGHTS[current]).toBeGreaterThan(INTEREST_ACTION_WEIGHTS[previous])
    }
  })

  test('负反馈全为负权', () => {
    for (const eventType of ['QUICK_SKIP', 'UNFAVORITE', 'HIDE'] as const) {
      expect(INTEREST_ACTION_WEIGHTS[eventType]).toBeLessThan(0)
    }
  })

  test('零权名单与权重表严格一致（SQL 的 NOT IN 用前者，改权重忘改名单会红）', () => {
    const derived = RecommendationEventTypeSchema.options.filter(
      (eventType) => INTEREST_ACTION_WEIGHTS[eventType] === 0,
    )
    expect([...INTEREST_ZERO_WEIGHT_EVENT_TYPES]).toEqual([...derived])
  })
})

describe('interestDecayFactor', () => {
  test('半衰期处恰好衰减一半，年龄为 0 时权重为 1', () => {
    expect(interestDecayFactor(0, SESSION_HALF_LIFE)).toBe(1)
    expect(interestDecayFactor(SESSION_HALF_LIFE, SESSION_HALF_LIFE)).toBe(0.5)
    expect(interestDecayFactor(2 * SESSION_HALF_LIFE, SESSION_HALF_LIFE)).toBe(0.25)
  })

  test('时钟超前（负年龄）按 0 龄处理，不会给出 >1 的权重', () => {
    expect(interestDecayFactor(-5 * 1000, SESSION_HALF_LIFE)).toBe(1)
  })

  test('半衰期必须为正数', () => {
    expect(() => interestDecayFactor(0, 0)).toThrow('半衰期必须为正数')
  })
})

describe('aggregateInterestVector', () => {
  test('单条行为 → 方向等于该商品向量（L2 归一化）', () => {
    const outcome = aggregateInterestVector({
      actions: [action('DETAIL_VIEW', [3, 4, 0])],
      now: NOW,
      halfLifeMs: SESSION_HALF_LIFE,
    })
    expect(outcome.vector).not.toBeNull()
    expect(outcome.vector?.[0]).toBeCloseTo(0.6, 10)
    expect(outcome.vector?.[1]).toBeCloseTo(0.8, 10)
    expect(outcome.vector?.[2]).toBeCloseTo(0, 10)
    expect(outcome.usedActions).toBe(1)
    expect(outcome.skipped).toEqual({ noVector: 0, zeroWeight: 0, decayed: 0 })
  })

  test('多条行为按权重加权，结果模长为 1', () => {
    const outcome = aggregateInterestVector({
      actions: [action('DETAIL_VIEW', X, HOUR), action('FAVORITE', Y, 0)],
      now: NOW,
      halfLifeMs: SESSION_HALF_LIFE,
    })
    expect(outcome.vector).not.toBeNull()
    expect(norm(outcome.vector ?? [])).toBeCloseTo(1, 10)
    // FAVORITE(4) 且更新，权重远大于 1 小时前的 DETAIL_VIEW(1，decay 0.25) → 明显偏向 Y。
    expect(dot(outcome.vector ?? [], Y)).toBeGreaterThan(dot(outcome.vector ?? [], X))
    expect(outcome.usedActions).toBe(2)
  })

  test('负权行为产生反向兴趣，而不是被抵消掉', () => {
    const outcome = aggregateInterestVector({
      actions: [action('HIDE', Y)],
      now: NOW,
      halfLifeMs: SESSION_HALF_LIFE,
    })
    expect(outcome.vector).not.toBeNull()
    expect(dot(outcome.vector ?? [], Y)).toBeCloseTo(-1, 10)
  })

  test('曝光（权重 0）既不进分子也不进分母，也不计入 usedActions', () => {
    const outcome = aggregateInterestVector({
      actions: [action('IMPRESSION', X), action('IMPRESSION', Y), action('DETAIL_VIEW', Y, HOUR)],
      now: NOW,
      halfLifeMs: SESSION_HALF_LIFE,
    })
    expect(outcome.vector).not.toBeNull()
    expect(dot(outcome.vector ?? [], Y)).toBeCloseTo(1, 10)
    expect(outcome.usedActions).toBe(1)
    expect(outcome.skipped).toEqual({ noVector: 0, zeroWeight: 2, decayed: 0 })
  })

  test('只有曝光 → null（无画像，绝不返回零向量）', () => {
    const outcome = aggregateInterestVector({
      actions: [action('IMPRESSION', X), action('IMPRESSION', Y)],
      now: NOW,
      halfLifeMs: SESSION_HALF_LIFE,
    })
    expect(outcome.vector).toBeNull()
    expect(outcome.usedActions).toBe(0)
    expect(outcome.skipped.zeroWeight).toBe(2)
  })

  test('无可用向量 → null 并计数（未生成 / 异模型 / 过期都由调用方折算成 null）', () => {
    const outcome = aggregateInterestVector({
      actions: [action('DETAIL_VIEW', null), action('FAVORITE', null)],
      now: NOW,
      halfLifeMs: SESSION_HALF_LIFE,
    })
    expect(outcome.vector).toBeNull()
    expect(outcome.skipped).toEqual({ noVector: 2, zeroWeight: 0, decayed: 0 })
  })

  test('窗口内没有行为 → null', () => {
    const outcome = aggregateInterestVector({
      actions: [],
      now: NOW,
      halfLifeMs: SESSION_HALF_LIFE,
    })
    expect(outcome.vector).toBeNull()
    expect(outcome.usedActions).toBe(0)
  })

  test('衰减下溢的远古行为不冒充 session 兴趣 → null', () => {
    const ageMs = 60 * DAY
    expect(interestDecayFactor(ageMs, SESSION_HALF_LIFE)).toBeLessThan(INTEREST_MIN_ACTION_DECAY)
    const outcome = aggregateInterestVector({
      actions: [action('DETAIL_VIEW', X, ageMs)],
      now: NOW,
      halfLifeMs: SESSION_HALF_LIFE,
    })
    expect(outcome.vector).toBeNull()
    expect(outcome.skipped).toEqual({ noVector: 0, zeroWeight: 0, decayed: 1 })
  })

  test('正负证据权重相抵恰好归零 → null（不是零向量）', () => {
    const outcome = aggregateInterestVector({
      actions: [action('IMAGE_VIEW', X, HOUR), action('QUICK_SKIP', X, HOUR)],
      now: NOW,
      halfLifeMs: SESSION_HALF_LIFE,
    })
    expect(outcome.vector).toBeNull()
    expect(outcome.usedActions).toBe(2)
  })

  test('session 兴趣快速响应最近行为：长看教材，今天连看骑行 → session 明显偏向骑行', () => {
    const actions = [
      action('FAVORITE', X, 12 * DAY),
      action('LONG_VIEW', X, 11 * DAY),
      action('DETAIL_VIEW', X, 9 * DAY),
      action('DETAIL_VIEW', Y, 2 * 60 * 1000),
      action('LONG_VIEW', Y, 60 * 1000),
      action('FAVORITE', Y, 30 * 1000),
    ]
    const session = aggregateInterestVector({ actions, now: NOW, halfLifeMs: SESSION_HALF_LIFE })
    const longTerm = aggregateInterestVector({ actions, now: NOW, halfLifeMs: LONG_TERM_HALF_LIFE })

    expect(session.vector).not.toBeNull()
    expect(longTerm.vector).not.toBeNull()
    // session：12 天前的偏好在 30 分钟半衰期下几乎归零 → 几乎完全跟着今天的骑行方向。
    expect(dot(session.vector ?? [], Y)).toBeGreaterThan(0.99)
    // 长期：两周半衰期下老偏好仍有分量 → 明显比 session 更靠近教材，且不像 session 那样极端。
    expect(dot(longTerm.vector ?? [], X)).toBeGreaterThan(0)
    expect(dot(longTerm.vector ?? [], Y)).toBeLessThan(dot(session.vector ?? [], Y))
  })

  test('同输入重复计算可复现，且与传入顺序无关（SQL 次级排序抖动不会改变画像）', () => {
    const actions = [
      action('FAVORITE', X, 3 * HOUR),
      action('LONG_VIEW', Y, 7 * HOUR),
      action('HIDE', Z, 10 * HOUR),
    ]
    const first = aggregateInterestVector({ actions, now: NOW, halfLifeMs: SESSION_HALF_LIFE })
    const second = aggregateInterestVector({ actions, now: NOW, halfLifeMs: SESSION_HALF_LIFE })
    const [favorite, longView, hide] = actions
    if (!favorite || !longView || !hide) throw new Error('顺序无关用例：行为样本缺少元素')
    const shuffled = aggregateInterestVector({
      actions: [hide, favorite, longView],
      now: NOW,
      halfLifeMs: SESSION_HALF_LIFE,
    })

    expect(second.vector).toEqual(first.vector)
    expect(shuffled.vector).not.toBeNull()
    for (let index = 0; index < (first.vector ?? []).length; index += 1) {
      expect(shuffled.vector?.[index]).toBeCloseTo(first.vector?.[index] ?? 0, 12)
    }
  })

  test('维度不一致直接抛错（静默截断只会产出垃圾向量）', () => {
    expect(() =>
      aggregateInterestVector({
        actions: [action('DETAIL_VIEW', X), action('FAVORITE', [1, 0])],
        now: NOW,
        halfLifeMs: SESSION_HALF_LIFE,
      }),
    ).toThrow('向量维度不一致')
  })

  test('空向量抛错', () => {
    expect(() =>
      aggregateInterestVector({
        actions: [action('DETAIL_VIEW', [])],
        now: NOW,
        halfLifeMs: SESSION_HALF_LIFE,
      }),
    ).toThrow('商品向量为空数组')
  })
})

describe('interestLookbackStart（行为回看起点）', () => {
  test('起点 = now − 180 天，与事件 retention 对齐', () => {
    const start = interestLookbackStart(NOW)
    expect(NOW.getTime() - start.getTime()).toBe(INTEREST_LONG_TERM_WINDOW_DAYS * DAY)
    expect(start.toISOString()).toBe('2025-09-02T12:00:00.000Z')
  })

  test('session 与长期画像共用同一起点（差别只在条数窗与半衰期）', () => {
    // 落在窗口内 1ms 的行为仍参与聚合；早 1ms 的会被 SQL 的 `occurred_at >= since` 排除。
    const start = interestLookbackStart(NOW)
    const inside = aggregateInterestVector({
      actions: [{ eventType: 'FAVORITE', vector: Y, occurredAt: start }],
      now: NOW,
      halfLifeMs: LONG_TERM_HALF_LIFE,
    })
    expect(inside.vector).not.toBeNull()
  })
})
