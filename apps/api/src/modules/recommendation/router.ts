import { RECOMMENDATION_HEADERS } from '@fish/contracts/recommendation/routes'
import {
  RecommendationEventBatchSchema,
  RecommendationFeedQuerySchema,
} from '@fish/contracts/recommendation/schema'
import { errorBody, validationDetails } from '@fish/contracts/system/error'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { LatencyRecorder } from '../../observability/latency'
import type { RecommendationProcessMetricsRecorder } from '../../observability/recommendation-metrics'
import type { AuthVariables } from '../auth/middleware'
import { readAnonymousSessionId } from './context'
import {
  RecommendationRateLimitError,
  rateLimitSubjects,
  type TokenBucketLimiter,
} from './rate-limit'
import { type RecommendationService, RecommendationServiceError } from './service'

export type RecommendationRouterOptions = {
  service: RecommendationService
  /**
   * 读接口的**可选**身份：匿名返回 null。
   *
   * 推荐 Feed 与埋点写入都**匿名可用**：首页对未登录访客必须能出内容，埋点更不能要求登录
   * （否则登录前的行为全部丢失，冷启动永远学不到东西）。所以这里不挂 `requireAuth`。
   */
  resolveViewerId: (c: Context) => Promise<string | null>
  /**
   * 进程内延迟采样（#323 R6 §6.4）。**可选**：测试与嵌入场景可以不接，
   * 不接就是"没有这一路延迟数据"，不影响响应。
   */
  latency?: LatencyRecorder
  /**
   * 进程内限流（#323 R6 §8.1，两份令牌桶：埋点与 Feed）。**可选**：不接＝不限流，
   * 只服务于"不关心限流"的测试；生产装配（`app.ts`）必须注入。
   */
  rateLimit?: { events: TokenBucketLimiter; feed: TokenBucketLimiter }
  /**
   * 可信出口 IP（#323 R6 §2.3）：由 `app.ts` 复用既有的 `resolveClientIp`
   * （`trustedClientIp(request, peerIp, trustedProxyIp)`）。**缺省返回 null ⇒ 匿名落到共享兜底桶**
   * （fail-closed：宁可共享一个桶，也不能让"伪造转发头"变成免限通道）。
   */
  resolveClientIp?: (c: Context) => string | null
  /** 进程内计数（#323 R6 §6.3）：此处只记"被 429 拒绝的请求数"，与 service 共用同一个实例。 */
  processMetrics?: RecommendationProcessMetricsRecorder
}

/** JSON 解析失败（空体 / 非 JSON）按参数不合法处理，而不是让 Hono 抛 500。 */
async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    return null
  }
}

function zodValidationFailure(
  c: Context,
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
) {
  return c.json(errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(issues)), 422)
}

/** 业务异常 → 契约错误信封；其它异常继续上抛给 `app.onError`。 */
function toErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof RecommendationServiceError) {
    return c.json(errorBody(error.code, error.message, error.details), error.status)
  }
  if (error instanceof RecommendationRateLimitError) {
    // 429 的形态照 `visual-search/router.ts:50-66`：剩余秒数走结构化字段（客户端据此显示倒计时），
    // `Retry-After` 头只是给中间层/网关的兜底提示。
    c.header('Retry-After', String(error.retryAfterSeconds))
    return c.json(
      errorBody(error.code, error.message, undefined, error.retryAfterSeconds),
      error.status,
    )
  }
  throw error
}

/**
 * 取令牌，不过就抛 429（#323 R6 §8.1）。
 *
 * 未接限流时直接放行：限流是**可选的横切**，不接它的调用方（测试、嵌入式场景）行为与 R5 一致。
 * 被拒的请求计进 `rateLimitedRequests`——这正是"bot 流量在指标上可见"的那一列（§8.2 第 4 条）。
 */
function takeTokens(
  limiter: TokenBucketLimiter | undefined,
  subjects: readonly string[],
  processMetrics: RecommendationProcessMetricsRecorder | undefined,
): void {
  if (limiter === undefined) return
  const decision = limiter.takeAll(subjects)
  if (!decision.allowed) {
    processMetrics?.recordRateLimitedRequest()
    throw new RecommendationRateLimitError(decision.retryAfterSeconds)
  }
}

export function createRecommendationRouter(options: RecommendationRouterOptions) {
  const { service } = options
  const router = new Hono<{ Variables: AuthVariables }>()

  /**
   * 推荐 Feed（#323 §M7）。
   *
   * R1 是"透传 `newest` + 生成推荐上下文"的最小可用入口：它存在**不是为了**改变首页内容，
   * 而是为了让曝光/详情有真实的 `requestId` 可归因（`GET /listings` 的契约里没有、也不该有
   * 推荐上下文字段）。真实召回与排序归 R3/R4。
   */
  router.get('/feed', async (c) => {
    // 整段处理耗时（#323 R6 §6.4）：含 422 早退，这样"参数不合法"也计入延迟分布，
    // 否则分位只统计成功请求，慢查询被"合法请求"平均掉。
    const startedAt = performance.now()
    try {
      const parsed = RecommendationFeedQuerySchema.safeParse(c.req.query())
      if (!parsed.success) return zodValidationFailure(c, parsed.error.issues)

      const viewerId = await options.resolveViewerId(c)
      const anonymousSessionId = readAnonymousSessionId(c)
      // Feed 也过限流（§8.1 最后一条）：`requestId` 是写归因事件的前提，不限 Feed 等于给脚本
      // 一条"免费取号"通道——不写事件就能拿到成千上万个 requestId。位置在契约校验之后、查库之前：
      // 被限流的请求不该先花掉一次多路召回。
      takeTokens(
        options.rateLimit?.feed,
        rateLimitSubjects({
          viewerId,
          anonymousSessionIds: [anonymousSessionId],
          clientIp: options.resolveClientIp?.(c) ?? null,
        }),
        options.processMetrics,
      )
      const page = await service.startFeed({
        viewerId,
        anonymousSessionId,
        limit: parsed.data.limit,
        ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
      })
      // 服务端补发的会话标识必须回写：客户端存不下来就会每次都是新会话，会话级信号全废。
      // （`Access-Control-Expose-Headers` 在 app.ts 的 cors 配置里放开这个头。）
      if (page.issuedAnonymousSessionId !== null) {
        c.header(RECOMMENDATION_HEADERS.sessionId, page.issuedAnonymousSessionId)
      }
      return c.json(page.response, 200)
    } catch (error) {
      return toErrorResponse(c, error)
    } finally {
      options.latency?.observe('feed', performance.now() - startedAt)
    }
  })

  /**
   * 行为事件批量写入（#323 §M0）。匿名可写、202。
   *
   * 会话标识**只从 body 取**（每条事件自带 `anonymousSessionId`）：离线队列补发时，
   * 一批事件可能横跨会话切换，用请求头里的"当前会话"覆盖它们会把历史行为记到错的会话上。
   */
  router.post('/events', async (c) => {
    const startedAt = performance.now()
    try {
      const parsed = RecommendationEventBatchSchema.safeParse(await readJson(c))
      if (!parsed.success) return zodValidationFailure(c, parsed.error.issues)

      const viewerId = await options.resolveViewerId(c)
      // 按**批**扣 1 个令牌（不是按事件条数）：批上限 50 条，按条扣会让一次翻页的 20 条曝光
      // 吃掉六分之一容量，正常用户滚动两下就被限。会话取本批事件里出现过的全部（离线补发跨会话）。
      takeTokens(
        options.rateLimit?.events,
        rateLimitSubjects({
          viewerId,
          anonymousSessionIds: parsed.data.events.map((event) => event.anonymousSessionId),
          clientIp: options.resolveClientIp?.(c) ?? null,
        }),
        options.processMetrics,
      )
      return c.json(await service.ingest({ viewerId, events: parsed.data.events }), 202)
    } catch (error) {
      return toErrorResponse(c, error)
    } finally {
      options.latency?.observe('events', performance.now() - startedAt)
    }
  })

  return router
}

export type RecommendationRouter = ReturnType<typeof createRecommendationRouter>
