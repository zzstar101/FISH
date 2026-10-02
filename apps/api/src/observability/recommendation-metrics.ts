/**
 * 推荐埋点的**进程内**计数（#323 R6 §6.3 / 决策 D5、N2）。
 *
 * 与 `latency.ts` 同一取舍：R6 的约束是零 schema 变更 + 不引依赖，而这些数字
 * （写入失败、被限流的请求、事件被拒收的原因分布）只需要"能被 admin 读到"。
 * 因此它们是几个整数，进程重启归零、多实例各自一份——契约字段与响应里的 `processStartedAt`
 * 必须把这件事说清楚，否则读的人会当成全局值。
 *
 * 依赖方向：本文件不属于任何 domain，`app.ts` 建一个实例，**写方**（recommendation service / router）
 * 调用它的 `record*`，**读方**（admin service）只读 `snapshot()`。admin 模块因此不需要 import
 * 推荐模块的内部对象，推荐模块也不需要知道 admin 存在。
 *
 * 为什么计数器与"读侧端口类型"放在同一个文件：`snapshot()` 的返回类型与 admin 读到的形状
 * 是同一份结构，分开写早晚会出现"加了一个计数点但 admin 不读它"（或反过来，admin 读一个
 * 永远为 0 的字段）而不报错。
 */

/**
 * 事件被拒收的原因（**对外口径**）。
 *
 * 与 `apps/api/src/modules/recommendation/service.ts` 里 7 个真实拒绝分支的映射写在 service 侧
 * （用 `satisfies Record<内部原因, RecommendationRejectionReason>` 保证穷尽）：
 * - `listing_not_found` → `listingNotFound`
 * - `identity_mismatch` → `identityMismatch`
 * - `request_not_found` / `attribution_not_found` → `attributionNotFound`
 * - `occurred_at_in_future` / `occurred_at_too_old` → `occurredAtOutOfRange`
 * - `server_confirmed_event_type` → `serverConfirmedEventType`
 *
 * 7 → 5 的合并是刻意的：`request_not_found` 与 `attribution_not_found` 对运维是同一件事
 * （"这条曝光找不到能归属的推荐请求"），而拆成两列只会让看板多一个永远与另一个同向的曲线。
 * 反过来，`serverConfirmedEventType` **不能**被并进别的桶——它意味着"客户端在伪造只能由
 * 服务端确认的行为"（成交/开聊），是刷量信号里最有信息量的一类。
 */
export type RecommendationRejectionReason =
  | 'attributionNotFound'
  | 'identityMismatch'
  | 'listingNotFound'
  | 'occurredAtOutOfRange'
  | 'serverConfirmedEventType'

/** 固定顺序：`snapshot()` 每次都返回全部 5 个键（没发生过的原因是 0，不是缺字段）。 */
export const RECOMMENDATION_REJECTION_REASONS = [
  'attributionNotFound',
  'identityMismatch',
  'listingNotFound',
  'occurredAtOutOfRange',
  'serverConfirmedEventType',
] as const satisfies readonly RecommendationRejectionReason[]

export type RecommendationEventRejectionCounts = Record<RecommendationRejectionReason, number>

/** admin 端点读到的形状（对应契约的 `eventWriteFailureRate` / `rateLimitedRequests` / `eventRejectionReasons`）。 */
export type RecommendationProcessMetrics = {
  /** 事件写入尝试次数（**以批为单位**，与 `eventWriteFailures` 同量纲）。 */
  eventWriteAttempts: number
  eventWriteFailures: number
  /** 被 429 拒绝的请求数（埋点与 Feed 两份桶都算）。 */
  rateLimitedRequests: number
  eventRejectionReasons: RecommendationEventRejectionCounts
}

export interface RecommendationProcessMetricsRecorder {
  recordEventWriteAttempt(): void
  recordEventWriteFailure(): void
  recordRateLimitedRequest(): void
  recordEventRejection(reason: RecommendationRejectionReason): void
  /** 只读快照：admin 每次请求读一份，拿到的是副本（调用方改不动计数器）。 */
  snapshot(): RecommendationProcessMetrics
}

function emptyRejectionCounts(): RecommendationEventRejectionCounts {
  const counts = {} as RecommendationEventRejectionCounts
  for (const reason of RECOMMENDATION_REJECTION_REASONS) {
    counts[reason] = 0
  }
  return counts
}

/**
 * 建一个进程内计数器（`app.ts` 每进程一个，同时交给推荐模块与 admin 模块）。
 *
 * 并发安全：Node/Bun 单线程事件循环下，`++` 是同步的，而所有 `record*` 都在请求处理里同步调用，
 * 不存在"读-改-写"交错；因此不需要原子操作或锁（这也是"进程内计数"能做到零成本的原因）。
 */
export function createRecommendationProcessMetrics(): RecommendationProcessMetricsRecorder {
  let eventWriteAttempts = 0
  let eventWriteFailures = 0
  let rateLimitedRequests = 0
  const eventRejectionReasons = emptyRejectionCounts()

  return {
    recordEventWriteAttempt(): void {
      eventWriteAttempts += 1
    },
    recordEventWriteFailure(): void {
      eventWriteFailures += 1
    },
    recordRateLimitedRequest(): void {
      rateLimitedRequests += 1
    },
    recordEventRejection(reason: RecommendationRejectionReason): void {
      eventRejectionReasons[reason] += 1
    },
    snapshot(): RecommendationProcessMetrics {
      return {
        eventWriteAttempts,
        eventWriteFailures,
        rateLimitedRequests,
        eventRejectionReasons: { ...eventRejectionReasons },
      }
    },
  }
}

/**
 * "没有接上计数器"时的默认值（全 0）。
 *
 * **不是"没有失败"，而是"还没接上计数"**：`eventWriteFailureRate` 因此是 `null`（0/0 口径，
 * 见 admin service 的 `ratio`），而不是 0。生产装配（`app.ts`）永远注入真实计数器；
 * 这个常量只服务于"不关心计数"的测试与可选依赖的缺省。
 */
export const NO_RECOMMENDATION_PROCESS_METRICS: RecommendationProcessMetrics = {
  eventWriteAttempts: 0,
  eventWriteFailures: 0,
  rateLimitedRequests: 0,
  eventRejectionReasons: emptyRejectionCounts(),
}
