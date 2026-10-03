/**
 * 离线评估契约测试（Issue #323 R6 §10.1）。
 *
 * 这些常量是**指标定义**的一部分：改分级/改 K/改负向集合都会让历史数字不可比，
 * 所以每一项都在这里钉住，而不是只断言"是个对象"。
 */

import { describe, expect, test } from 'bun:test'
import {
  RANK_EVAL_ATTRIBUTION_WINDOW_MS,
  RANK_EVAL_DEFAULT_WINDOW_DAYS,
  RANK_EVAL_FRESH_ITEM_DAYS,
  RANK_EVAL_K_VALUES,
  RANK_EVAL_NEGATIVE_EVENT_TYPES,
  RANK_EVAL_RELEVANCE_GRADES,
} from './eval'
import { RANK_NEGATIVE_FEEDBACK_EVENT_TYPES } from './rank'
import { RecommendationEventTypeSchema } from './schema'

describe('RANK_EVAL_RELEVANCE_GRADES', () => {
  test('三级分级：成交/发起交易最强，聊天/评论/收藏次之，详情最弱', () => {
    expect(RANK_EVAL_RELEVANCE_GRADES.PURCHASE).toBe(3)
    expect(RANK_EVAL_RELEVANCE_GRADES.TRANSACTION_START).toBe(3)
    expect(RANK_EVAL_RELEVANCE_GRADES.CHAT_START).toBe(2)
    expect(RANK_EVAL_RELEVANCE_GRADES.COMMENT).toBe(2)
    expect(RANK_EVAL_RELEVANCE_GRADES.FAVORITE).toBe(2)
    expect(RANK_EVAL_RELEVANCE_GRADES.DETAIL_VIEW).toBe(1)
  })

  test('所有分级都 > 0，否则"相关集 = grade > 0"会把它们漏掉', () => {
    for (const grade of Object.values(RANK_EVAL_RELEVANCE_GRADES)) {
      expect(grade).toBeGreaterThan(0)
    }
  })

  test('分级的键都是合法事件类型（写错名字不会在运行时被发现）', () => {
    for (const eventType of Object.keys(RANK_EVAL_RELEVANCE_GRADES)) {
      expect(RecommendationEventTypeSchema.safeParse(eventType).success).toBe(true)
    }
  })

  test('负向事件不出现在分级里：命中即剔除，不是记负分', () => {
    for (const eventType of RANK_EVAL_NEGATIVE_EVENT_TYPES) {
      expect(eventType in RANK_EVAL_RELEVANCE_GRADES).toBe(false)
    }
  })

  test('负向集合复用排序层的常量（同一份"多负"只定义一次）', () => {
    expect(RANK_EVAL_NEGATIVE_EVENT_TYPES).toBe(RANK_NEGATIVE_FEEDBACK_EVENT_TYPES)
  })
})

describe('评估窗与 K', () => {
  test('三档 K 都报，且含默认页大小 20', () => {
    expect([...RANK_EVAL_K_VALUES]).toEqual([5, 10, 20])
  })

  test('默认窗口 7 天、新鲜商品阈值 7 天（都受保留期约束）', () => {
    expect(RANK_EVAL_DEFAULT_WINDOW_DAYS).toBe(7)
    expect(RANK_EVAL_FRESH_ITEM_DAYS).toBe(7)
  })

  test('归因窗 W 固化 30 分钟（不是 CLI 旗标，改它历史数据不可比）', () => {
    expect(RANK_EVAL_ATTRIBUTION_WINDOW_MS).toBe(30 * 60_000)
    // 必须严格小于默认评估窗，否则「请求后 W 内」会把整段回放窗吞掉、退化成「不做归因」。
    expect(RANK_EVAL_ATTRIBUTION_WINDOW_MS).toBeLessThan(RANK_EVAL_DEFAULT_WINDOW_DAYS * 86_400_000)
  })
})
