import { AI_ROUTES } from '@fish/contracts/ai/routes'
import { AiPolishCandidatesRequestSchema } from '@fish/contracts/ai/schema'
import { errorBody, validationDetails } from '@fish/contracts/system/error'
import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import { type AiPolishService, AiPolishServiceError } from './service'

export type AiPolishRouterOptions = {
  service: AiPolishService
  /**
   * 端点整体要求登录（未登录 401，不给匿名者烧配额）。**不能用 `router.use('*', requireAuth)`**：
   * 本 router 挂在根路径，`use('*')` 会波及同进程其它根级路由。
   */
  requireAuth: MiddlewareHandler<{ Variables: AuthVariables }>
}

/** JSON 解析失败（空体 / 非 JSON）按参数不合法处理，而不是让 Hono 抛 500。 */
async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    return null
  }
}

/** 业务异常 → 契约错误信封；其它异常继续上抛给 `app.onError`（500）。 */
function toErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof AiPolishServiceError) {
    // 429 的 retryAfterSeconds 走结构化字段，客户端不必解析 message 文案（契约 §4.2）。
    return c.json(
      errorBody(error.code, error.message, undefined, error.retryAfterSeconds),
      error.status,
    )
  }
  throw error
}

/**
 * AI 润色 router（#141）。
 *
 * 挂在根路径（`app.route('/', …)`）——路径字面量只在契约的 `AI_ROUTES` 里存在一处。
 */
export function createAiPolishRouter(options: AiPolishRouterOptions) {
  const router = new Hono<{ Variables: AuthVariables }>()

  router.post(AI_ROUTES.polishCandidates, options.requireAuth, async (c) => {
    // title / description / category 全走契约的 strictObject：多字段、空描述、超 500、非法分类
    // 都在这里变成 422（设计 §5.1）。服务端独立成立，不依赖客户端本地校验。
    const parsed = AiPolishCandidatesRequestSchema.safeParse(await readJson(c))
    if (!parsed.success) {
      return c.json(
        errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(parsed.error.issues)),
        422,
      )
    }

    try {
      const body = await options.service.polishCandidates({
        userId: c.get('userId'),
        ...parsed.data,
      })
      return c.json(body, 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  return router
}
