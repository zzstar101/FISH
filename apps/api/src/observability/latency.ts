import { RECOMMENDATION_LATENCY_SAMPLE_CAPACITY } from '@fish/contracts/recommendation/observability'

/**
 * 进程内延迟采样（Issue #323 / R6 §6.4，决策 D5 / N2）。
 *
 * 为什么不做成一个通用 metrics 模块 / 不引 Prometheus：R6 的明确约束是**零 schema 变更 + 不引依赖**，
 * 而需要延迟分位数的调用点只有三个（Feed、事件写入、pgvector 查询）。一个环形缓冲 + 读时排序就够，
 * 引入指标后端要改部署、要新依赖、要让每个进程都暴露端口，成本与"看清三个调用点"不成比例。
 *
 * **单进程口径**：进程重启清零、多实例各自为政。契约字段注释与响应里的 `processStartedAt`
 * 都必须把这件事说清楚——读的人最容易把这种数字当成全局值。
 *
 * 依赖方向：本文件不属于任何 domain，`app.ts` 建一个实例同时交给**写方**（recommendation router /
 * recall service）与**读方**（admin service）。admin 模块因此不需要 import recommendation 模块的内部对象。
 */
export type LatencyMetric = 'feed' | 'events' | 'pgvector'

/** 固定顺序：契约里的 `latency` 数组永远三项齐全（没采到样时 `count = 0`、分位为 `null`）。 */
export const LATENCY_METRICS = [
  'feed',
  'events',
  'pgvector',
] as const satisfies readonly LatencyMetric[]

export type LatencySnapshot = {
  metric: LatencyMetric
  count: number
  p50Ms: number | null
  p95Ms: number | null
  p99Ms: number | null
  maxMs: number | null
}

export type LatencyRecorder = {
  /** 记一次耗时（毫秒）。非有限值 / 负值直接丢弃：上游时钟异常不该污染分位数。 */
  observe(metric: LatencyMetric, durationMs: number): void
  snapshot(): LatencySnapshot[]
  /** 本实例创建时刻：所有样本的观察起点。 */
  readonly startedAt: Date
}

type MetricBuffer = {
  /** 定长环形缓冲：写入 O(1) 且不分配，回绕后覆盖最旧的样本。 */
  samples: Float64Array
  /** 下一个写入位置（回绕）。 */
  next: number
  /** 已写入的样本数，上限为 `samples.length`。 */
  filled: number
}

/**
 * 最近秩（nearest-rank）分位数：取第 `ceil(p * n)` 个样本。
 *
 * 不用插值：样本是"某次请求实际花了多久"，插出来的数在真实样本里并不存在，
 * 排查延迟时容易被当成"某次真的这么慢"。n 很小时（比如 3 个样本）这个选择也更保守。
 */
function percentileOf(sorted: readonly number[], p: number): number {
  const rank = Math.ceil(p * sorted.length)
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1)
  const value = sorted[index]
  return value === undefined ? 0 : value
}

export function createLatencyRecorder(options: {
  /** 每个指标的样本容量（见 `RECOMMENDATION_LATENCY_SAMPLE_CAPACITY`）。 */
  capacity: number
  clock?: () => Date
}): LatencyRecorder {
  if (!Number.isInteger(options.capacity) || options.capacity < 1) {
    throw new Error('延迟采样容量必须是正整数')
  }
  const clock = options.clock ?? (() => new Date())
  const startedAt = clock()
  const buffers = new Map<LatencyMetric, MetricBuffer>(
    LATENCY_METRICS.map((metric) => [
      metric,
      { samples: new Float64Array(options.capacity), next: 0, filled: 0 },
    ]),
  )

  return {
    startedAt,

    observe(metric, durationMs) {
      if (!Number.isFinite(durationMs) || durationMs < 0) return
      const buffer = buffers.get(metric)
      // 类型上不可能，但 `Metric` 是开放联合时（将来加指标忘了进 LATENCY_METRICS）这里必须不炸。
      if (!buffer) return
      buffer.samples[buffer.next] = durationMs
      buffer.next = (buffer.next + 1) % buffer.samples.length
      if (buffer.filled < buffer.samples.length) buffer.filled += 1
    },

    snapshot() {
      return LATENCY_METRICS.map((metric) => {
        const buffer = buffers.get(metric)
        const filled = buffer?.filled ?? 0
        if (!buffer || filled === 0) {
          return { metric, count: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null }
        }
        const sorted = Array.from(buffer.samples.slice(0, filled)).sort((a, b) => a - b)
        return {
          metric,
          count: filled,
          p50Ms: percentileOf(sorted, 0.5),
          p95Ms: percentileOf(sorted, 0.95),
          p99Ms: percentileOf(sorted, 0.99),
          maxMs: sorted[sorted.length - 1] ?? 0,
        }
      })
    },
  }
}

/** 默认容量下的 recorder（`app.ts` 用它装配；容量来源见契约）。 */
export function createDefaultLatencyRecorder(clock?: () => Date): LatencyRecorder {
  return createLatencyRecorder({ capacity: RECOMMENDATION_LATENCY_SAMPLE_CAPACITY, clock })
}
