import { describe, expect, it } from 'bun:test'
import { createLatencyRecorder, LATENCY_METRICS } from './latency'

/** 三个指标顺序固定：契约里的 `latency` 数组永远三项齐全。 */
function counts(recorder: ReturnType<typeof createLatencyRecorder>) {
  return recorder.snapshot().map((entry) => [entry.metric, entry.count] as const)
}

describe('进程内延迟采样（#323 R6 §6.4）', () => {
  it('没采到样时三项齐全，计数为 0、分位为 null', () => {
    const recorder = createLatencyRecorder({ capacity: 8 })
    const snapshot = recorder.snapshot()
    expect(snapshot.map((entry) => entry.metric)).toEqual([...LATENCY_METRICS])
    for (const entry of snapshot) {
      expect(entry.count).toBe(0)
      expect(entry.p50Ms).toBeNull()
      expect(entry.p95Ms).toBeNull()
      expect(entry.p99Ms).toBeNull()
      expect(entry.maxMs).toBeNull()
    }
  })

  it('100 个升序样本的最邻近秩分位数', () => {
    const recorder = createLatencyRecorder({ capacity: 256 })
    for (let i = 1; i <= 100; i += 1) recorder.observe('feed', i)
    const feed = recorder.snapshot().find((entry) => entry.metric === 'feed')
    expect(feed).toMatchObject({ count: 100, p50Ms: 50, p95Ms: 95, p99Ms: 99, maxMs: 100 })
  })

  it('分位取真实样本而不是插值：两个样本的 p95 是较大的那个', () => {
    const recorder = createLatencyRecorder({ capacity: 8 })
    recorder.observe('events', 10)
    recorder.observe('events', 20)
    const events = recorder.snapshot().find((entry) => entry.metric === 'events')
    // 插值会得到 19.5 —— 这个数在样本里不存在，排查延迟时会被误读成"某次真的花了 19.5ms"。
    expect(events?.p95Ms).toBe(20)
    expect(events?.p50Ms).toBe(10)
    expect(events?.p99Ms).toBe(20)
  })

  it('环形缓冲回绕后只保留最近 capacity 个样本', () => {
    const recorder = createLatencyRecorder({ capacity: 2 })
    recorder.observe('pgvector', 1)
    recorder.observe('pgvector', 2)
    recorder.observe('pgvector', 3)
    recorder.observe('pgvector', 4)
    const pgvector = recorder.snapshot().find((entry) => entry.metric === 'pgvector')
    // 只剩 [3, 4]：1 与 2 被覆盖。
    expect(pgvector).toMatchObject({ count: 2, p50Ms: 3, p95Ms: 4, maxMs: 4 })
  })

  it('容量填满后 count 不再增长，最旧的样本被覆盖', () => {
    const recorder = createLatencyRecorder({ capacity: 3 })
    for (const value of [5, 1, 9, 7]) recorder.observe('feed', value)
    const feed = recorder.snapshot().find((entry) => entry.metric === 'feed')
    // [1, 9, 7] 保留，5 被挤掉。max 一定是 9。
    expect(feed).toMatchObject({ count: 3, maxMs: 9 })
  })

  it('非有限值与负值丢弃：上游时钟异常不污染分位数', () => {
    const recorder = createLatencyRecorder({ capacity: 8 })
    recorder.observe('feed', Number.NaN)
    recorder.observe('feed', Number.POSITIVE_INFINITY)
    recorder.observe('feed', -1)
    recorder.observe('feed', 12)
    expect(counts(recorder)).toEqual([
      ['feed', 1],
      ['events', 0],
      ['pgvector', 0],
    ])
  })

  it('指标之间互不干扰', () => {
    const recorder = createLatencyRecorder({ capacity: 8 })
    recorder.observe('events', 3)
    recorder.observe('pgvector', 30)
    expect(counts(recorder)).toEqual([
      ['feed', 0],
      ['events', 1],
      ['pgvector', 1],
    ])
  })

  it('startedAt 取时钟，容量非法直接抛错', () => {
    const startedAt = new Date('2026-01-02T03:04:05.000Z')
    expect(createLatencyRecorder({ capacity: 4, clock: () => startedAt }).startedAt).toBe(startedAt)
    expect(() => createLatencyRecorder({ capacity: 0 })).toThrow('延迟采样容量必须是正整数')
    expect(() => createLatencyRecorder({ capacity: 1.5 })).toThrow('延迟采样容量必须是正整数')
  })
})
