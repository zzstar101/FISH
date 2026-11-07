/**
 * 推荐埋点与 Feed 的进程内限流（#323 R6，决策 D10 的细化）。
 *
 * 为什么是进程内令牌桶、不落库：R6 的约束是零 schema 变更（D5），而这里要防的是
 * **脚本刷量**——它只需要"让刷量的成本与线上量级同阶"，不需要跨实例的精确配额。
 * 代价写在明处：多实例部署时每个实例各有一份额度（契约的 `processStartedAt` 已经把
 * "这些数字是单进程的"讲清楚），重启即清零。真要全局配额就得引 Redis，那是本 Issue 的非目标。
 *
 * 为什么匿名要**同时**过会话与 IP 两条桶：事件体里的 `anonymousSessionId` 是客户端自述，
 * 换一个 UUID 就是新身份；只按会话限流等于没限流。IP 走 `trustedClientIp`（不可伪造的来源），
 * 无法归因时落到共享兜底桶——fail-closed：宁可让少量正常请求排队，也不能给"换 IP 即免限"留口子。
 *
 * 但两条桶**不必同一规格**（#643）：校园网/宿舍是 NAT 出口，整栋楼共用一个 `ip:` 主体，
 * 按会话的规格（60/1·s⁻¹）限 IP 等于把整栋楼的匿名用户挤进 1 次/秒。所以 `createTokenBucketLimiter`
 * 支持按主体选规格（`tierFor`）：Feed 的 `ip:` 桶用契约的 `RECOMMENDATION_FEED_IP_RATE_LIMIT`，
 * `session:` / `user:` / `ip:unattributed` 仍用 `RECOMMENDATION_FEED_RATE_LIMIT`。两个桶仍然同时生效、原子扣减，
 * 只是"整栋楼共享的那份额度"被放宽到 NAT 的真实量级。
 *
 * **IP 只作为进程内 Map 的键存在**：不落库、不进日志、不进响应（R1 的"不落 IP"承诺不变）。
 */
import { RECOMMENDATION_RATE_LIMITED } from '@fish/contracts/recommendation/schema'
import { normalizeIp } from '../listings/trusted-ip'

/** 无法归因出口 IP 时的共享兜底桶（形态照 `visual-search/subject.ts` 的 `UNATTRIBUTED_IP_SUBJECT`）。 */
export const RECOMMENDATION_UNATTRIBUTED_SUBJECT = 'unattributed'

/** 出口 IP 主体的前缀（`rateLimitSubjects` 产出 `ip:<归一化地址>`）。 */
export const RECOMMENDATION_IP_SUBJECT_PREFIX = 'ip:'

/**
 * 主体是否属于**可归因的**出口 IP 维度（#643：Feed 的 IP 桶用更宽的一档规格）。
 *
 * `unattributed` 刻意不算：它代表"IP 不可归因"的共享兜底桶，生产里出现即说明
 * `resolveClientIp` 装配有问题，这时该 fail-closed 回严格规格，而不是把全站匿名用户
 * 塞进一个 20·s⁻¹ 的宽松桶。
 */
export function isIpRateLimitSubject(subject: string): boolean {
  return (
    subject.startsWith(RECOMMENDATION_IP_SUBJECT_PREFIX) &&
    // `rateLimitSubjects` 把不可归因的 IP 写成 `ip:unattributed`（同样带前缀），它不是真实地址。
    subject !== `${RECOMMENDATION_IP_SUBJECT_PREFIX}${RECOMMENDATION_UNATTRIBUTED_SUBJECT}`
  )
}

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number }

/** 单个主体的令牌桶规格。 */
export type TokenBucketSpec = {
  /** 桶容量（正整数）。 */
  capacity: number
  /** 每秒补充的令牌数（正数，可小于 1）。 */
  refillPerSecond: number
}

export interface TokenBucketLimiter {
  /** 单一主体（登录用户）取令牌。 */
  take(subject: string): RateLimitDecision
  /**
   * 同一请求的多个主体（匿名 = 会话 + IP）必须**全部**通过；任一不过则整体拒绝，
   * 取最大等待秒数。全过时**一起扣**：被拒的请求不该白白消耗另一个主体的额度。
   */
  takeAll(subjects: readonly string[]): RateLimitDecision
}

/** 当前桶表里有多少个主体（测试与"桶表是否被 LRU 压住"用）。 */
export interface TokenBucketLimiterDebug {
  size(): number
}

/**
 * 被限流时抛出的独立错误。
 *
 * **不复用 `RecommendationServiceError`**：那个类被硬类型化成 `status: 422` + `code: 'VALIDATION_FAILED'`
 * （`service.ts`），把 429 塞进去就得把"只能 422"的类扩成多状态。由 router 的 `instanceof` 分支处理，
 * service 层因此完全不知道限流存在（它只负责"批已经通过校验"之后的事）。
 */
export class RecommendationRateLimitError extends Error {
  readonly status: 429 = 429
  readonly code = RECOMMENDATION_RATE_LIMITED
  readonly retryAfterSeconds: number

  constructor(retryAfterSeconds: number, message = '埋点写入过于频繁') {
    super(message)
    this.name = 'RecommendationRateLimitError'
    // 契约要求 `retryAfterSeconds` 是**正整数**（`errorBody` 的校验），且 0 会让客户端立刻重试。
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds))
  }
}

type Bucket = { tokens: number; updatedAt: number; spec: TokenBucketSpec }

/**
 * 令牌桶（每主体一份，`Map` 的插入序即 LRU 序）。
 *
 * 补充是**惰性**的：只在访问某个主体时按 `updatedAt` 到现在的间隔补，
 * 因此没有定时器、没有后台任务，空闲主体不消耗任何 CPU。
 */
export function createTokenBucketLimiter(options: {
  capacity: number
  refillPerSecond: number
  maxSubjects: number
  clock?: () => number
  /**
   * 按主体覆写桶规格（#643）。返回 `null` = 用上面的默认规格。
   *
   * 只在**首次见到某个主体**时调用一次：规格随桶一起存下来，之后补令牌按该桶自己的
   * `refillPerSecond` 算，不会因为主体被重新归类而"改口径"。
   */
  tierFor?: (subject: string) => TokenBucketSpec | null
}): TokenBucketLimiter & TokenBucketLimiterDebug {
  const { capacity, refillPerSecond, maxSubjects } = options
  const clock = options.clock ?? ((): number => Date.now())
  const defaultSpec: TokenBucketSpec = { capacity, refillPerSecond }

  assertTokenBucketSpec(defaultSpec)
  if (!Number.isInteger(maxSubjects) || maxSubjects < 1) {
    throw new Error('令牌桶主体上限必须是正整数')
  }

  const buckets = new Map<string, Bucket>()

  /** 取桶、补到当前时刻，并把它移到 LRU 尾部（超出上限时淘汰最久未用的主体）。 */
  function touch(subject: string, now: number): Bucket {
    const existing = buckets.get(subject)
    let bucket: Bucket
    if (existing === undefined) {
      const spec = options.tierFor?.(subject) ?? defaultSpec
      assertTokenBucketSpec(spec)
      bucket = { tokens: spec.capacity, updatedAt: now, spec }
    } else {
      const elapsedMs = Math.max(0, now - existing.updatedAt)
      existing.tokens = Math.min(
        existing.spec.capacity,
        existing.tokens + (elapsedMs / 1000) * existing.spec.refillPerSecond,
      )
      existing.updatedAt = now
      bucket = existing
      // 先删再插 = 移到 Map 尾部；`Map` 的迭代顺序就是 LRU 顺序，不需要额外的链表。
      buckets.delete(subject)
    }
    buckets.set(subject, bucket)

    if (buckets.size > maxSubjects) {
      const oldest = buckets.keys().next().value
      if (oldest !== undefined) {
        buckets.delete(oldest)
      }
    }
    return bucket
  }

  function decide(subjects: readonly string[]): RateLimitDecision {
    // 同一个主体在一批里出现多次（多条事件共用会话）只算一份，否则自己把自己限掉。
    const unique = [...new Set(subjects)]
    if (unique.length === 0) {
      return { allowed: true }
    }

    const now = clock()
    const touched: Bucket[] = []
    let retryAfterSeconds = 0

    for (const subject of unique) {
      const bucket = touch(subject, now)
      touched.push(bucket)
      if (bucket.tokens < 1) {
        // 补满到 1 个令牌还需要的秒数；向上取整（契约要求正整数）。
        // 按**该桶自己的**规格算：IP 桶与身份桶的补充速率不同。
        retryAfterSeconds = Math.max(
          retryAfterSeconds,
          Math.ceil((1 - bucket.tokens) / bucket.spec.refillPerSecond),
        )
      }
    }

    if (retryAfterSeconds > 0) {
      return { allowed: false, retryAfterSeconds: Math.max(1, retryAfterSeconds) }
    }
    for (const bucket of touched) {
      bucket.tokens -= 1
    }
    return { allowed: true }
  }

  return {
    take: (subject: string): RateLimitDecision => decide([subject]),
    takeAll: (subjects: readonly string[]): RateLimitDecision => decide(subjects),
    size: (): number => buckets.size,
  }
}

/** 构造期/首次建桶时校验规格：非法配置要当场炸，不能带病运行。 */
export function assertTokenBucketSpec(spec: TokenBucketSpec): void {
  if (!Number.isInteger(spec.capacity) || spec.capacity < 1) {
    throw new Error('令牌桶容量必须是正整数')
  }
  if (!Number.isFinite(spec.refillPerSecond) || spec.refillPerSecond <= 0) {
    throw new Error('令牌桶补充速率必须是正数')
  }
}

/**
 * 推导一次请求要过的限流主体。
 *
 * - 登录：`user:<userId>` 一条。**不再叠 IP**——登录身份不可自述伪造，叠上去只会让
 *   "同一 NAT 出口下的多个正常用户"互相抢额度；
 * - 匿名：`session:<会话>`（每个不同的会话一条）+ `ip:<可信出口 IP>`；IP 无法归因时用共享
 *   `ip:unattributed` 桶（fail-closed）。会话统一转小写，避免同一个 UUID 的大小写两种写法各占一个桶。
 *
 * `anonymousSessionIds` 是数组：Feed 的会话来自请求头（最多一条），埋点的会话来自事件体
 * （一次批量可能跨会话，离线补发时会带多个）。
 *
 * 本函数只回答"要过哪些主体"，**不回答"每个主体多少额度"**：额度由调用方建桶时的
 * `tierFor` 决定（#643：Feed 的 `ip:` 桶比 `session:` 桶宽，埋点仍是同一规格）。
 */
export function rateLimitSubjects(input: {
  viewerId: string | null
  anonymousSessionIds?: readonly (string | null | undefined)[]
  clientIp: string | null
}): string[] {
  const viewerId = input.viewerId
  if (viewerId !== null && viewerId.length > 0) {
    return [`user:${viewerId}`]
  }

  const subjects = new Set<string>()
  for (const sessionId of input.anonymousSessionIds ?? []) {
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      subjects.add(`session:${sessionId.toLowerCase()}`)
    }
  }
  subjects.add(
    `${RECOMMENDATION_IP_SUBJECT_PREFIX}${normalizeIp(input.clientIp) ?? RECOMMENDATION_UNATTRIBUTED_SUBJECT}`,
  )
  return [...subjects]
}
