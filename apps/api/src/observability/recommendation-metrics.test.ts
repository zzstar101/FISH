import { describe, expect, test } from 'bun:test'
import {
  createRecommendationProcessMetrics,
  NO_RECOMMENDATION_PROCESS_METRICS,
  RECOMMENDATION_REJECTION_REASONS,
  type RecommendationRejectionReason,
} from './recommendation-metrics'

/**
 * 进程内计数器（#323 R6 §6.3）。
 *
 * 这些数字是"只有进程知道"的东西（写入失败 / 被限流 / 拒收原因），没有表、没有日志解析兜底，
 * 所以这里的断言就是它们唯一的行为契约：**5 个键永远齐全**（没发生过是 0，不是缺字段）与
 * **`snapshot()` 是副本**（admin 读侧改不动计数器的内部状态）。
 */
describe('recommendation 进程内计数 (#323 R6)', () => {
  const reasonKeys = [...RECOMMENDATION_REJECTION_REASONS].sort()

  test('初始快照：4 个计数全 0，拒收原因 5 个键齐全', () => {
    const metrics = createRecommendationProcessMetrics().snapshot()

    expect(metrics.eventWriteAttempts).toBe(0)
    expect(metrics.eventWriteFailures).toBe(0)
    expect(metrics.rateLimitedRequests).toBe(0)
    // 缺字段会让 admin 端点 500（契约是 z.number()），而"缺字段"与"0 次"在 JSON 里长得完全不同。
    expect(Object.keys(metrics.eventRejectionReasons).sort()).toEqual(reasonKeys)
    expect(Object.values(metrics.eventRejectionReasons)).toEqual([0, 0, 0, 0, 0])
  })

  test('record* 只累加自己被调用的那个计数', () => {
    const recorder = createRecommendationProcessMetrics()

    recorder.recordEventWriteAttempt()
    recorder.recordEventWriteAttempt()
    recorder.recordEventWriteFailure()
    recorder.recordRateLimitedRequest()
    recorder.recordEventRejection('listingNotFound')
    recorder.recordEventRejection('listingNotFound')
    recorder.recordEventRejection('serverConfirmedEventType')

    const metrics = recorder.snapshot()
    expect(metrics.eventWriteAttempts).toBe(2)
    expect(metrics.eventWriteFailures).toBe(1)
    expect(metrics.rateLimitedRequests).toBe(1)
    expect(metrics.eventRejectionReasons).toEqual({
      attributionNotFound: 0,
      identityMismatch: 0,
      listingNotFound: 2,
      occurredAtOutOfRange: 0,
      serverConfirmedEventType: 1,
    })
  })

  test('5 个原因键都能各自累加（7 个内部原因合并成 5 桶后的每一桶都可达）', () => {
    const recorder = createRecommendationProcessMetrics()
    for (const reason of RECOMMENDATION_REJECTION_REASONS) {
      recorder.recordEventRejection(reason as RecommendationRejectionReason)
    }

    expect(recorder.snapshot().eventRejectionReasons).toEqual({
      attributionNotFound: 1,
      identityMismatch: 1,
      listingNotFound: 1,
      occurredAtOutOfRange: 1,
      serverConfirmedEventType: 1,
    })
  })

  test('snapshot() 是副本：改返回值不影响计数器，两次读到的也不是同一个对象', () => {
    const recorder = createRecommendationProcessMetrics()
    recorder.recordEventRejection('identityMismatch')

    const first = recorder.snapshot()
    first.eventRejectionReasons.identityMismatch = 99
    first.rateLimitedRequests = 99

    const second = recorder.snapshot()
    expect(second.eventRejectionReasons.identityMismatch).toBe(1)
    expect(second.rateLimitedRequests).toBe(0)
    expect(second).not.toBe(first)
    expect(second.eventRejectionReasons).not.toBe(first.eventRejectionReasons)
  })

  test('每次调用建的是独立计数器（两个实例不共享状态）', () => {
    const a = createRecommendationProcessMetrics()
    const b = createRecommendationProcessMetrics()
    a.recordRateLimitedRequest()

    expect(a.snapshot().rateLimitedRequests).toBe(1)
    expect(b.snapshot().rateLimitedRequests).toBe(0)
  })

  test('NO_RECOMMENDATION_PROCESS_METRICS 是"还没接上计数"的全 0 缺省值', () => {
    // 全 0 与"零失败"在数值上相同，区别由 admin service 的 ratio 口径表达：
    // 0/0 的 eventWriteFailureRate 是 null 而不是 0（见 service.test.ts）。
    expect(NO_RECOMMENDATION_PROCESS_METRICS.eventWriteAttempts).toBe(0)
    expect(NO_RECOMMENDATION_PROCESS_METRICS.eventWriteFailures).toBe(0)
    expect(NO_RECOMMENDATION_PROCESS_METRICS.rateLimitedRequests).toBe(0)
    expect(Object.keys(NO_RECOMMENDATION_PROCESS_METRICS.eventRejectionReasons).sort()).toEqual(
      reasonKeys,
    )
  })
})
