import { RECOMMENDATION_HEADERS } from '@fish/contracts/recommendation/routes'
import {
  RecommendationEventBatchSchema,
  RecommendationFeedQuerySchema,
} from '@fish/contracts/recommendation/schema'
import { errorBody, validationDetails } from '@fish/contracts/system/error'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import { readAnonymousSessionId } from './context'
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
  throw error
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
    const parsed = RecommendationFeedQuerySchema.safeParse(c.req.query())
    if (!parsed.success) return zodValidationFailure(c, parsed.error.issues)

    try {
      const viewerId = await options.resolveViewerId(c)
      const page = await service.startFeed({
        viewerId,
        anonymousSessionId: readAnonymousSessionId(c),
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
    }
  })

  /**
   * 行为事件批量写入（#323 §M0）。匿名可写、202。
   *
   * 会话标识**只从 body 取**（每条事件自带 `anonymousSessionId`）：离线队列补发时，
   * 一批事件可能横跨会话切换，用请求头里的"当前会话"覆盖它们会把历史行为记到错的会话上。
   */
  router.post('/events', async (c) => {
    const parsed = RecommendationEventBatchSchema.safeParse(await readJson(c))
    if (!parsed.success) return zodValidationFailure(c, parsed.error.issues)

    try {
      const viewerId = await options.resolveViewerId(c)
      return c.json(await service.ingest({ viewerId, events: parsed.data.events }), 202)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  return router
}

export type RecommendationRouter = ReturnType<typeof createRecommendationRouter>
