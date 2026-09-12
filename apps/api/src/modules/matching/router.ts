import { MatchListQuerySchema } from '@fish/contracts/matching/schema'
import { errorBody, validationDetails } from '@fish/contracts/system/error'
import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import { type MatchingService, MatchingServiceError } from './service'

export type MatchingRouterOptions = {
  service: MatchingService
  /**
   * 登录守卫由 `auth` 模块提供。匹配读接口**没有匿名路径**：契约 §0.2 要求
   * "目标必须是本人的"，所以整条路由挂 `requireAuth`（与 #6 的读公开/写登录不同）。
   */
  requireAuth: MiddlewareHandler<{ Variables: AuthVariables }>
}

/** 业务异常 → 契约错误信封；其它异常继续上抛给 `app.onError`（与 #6 的 router 同构）。 */
function toErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof MatchingServiceError) {
    return c.json(errorBody(error.code, error.message), error.status)
  }
  throw error
}

export function createMatchingRouter({ service, requireAuth }: MatchingRouterOptions) {
  const app = new Hono<{ Variables: AuthVariables }>()

  // 挂载点是 `/matches`（`apps/api/src/app.ts`），所以 router 内部用 `/`，
  // 与 #6 的 listings router 同构；真正的对外路径由 `MATCHING_ROUTES.base` 定义。
  app.get('/', requireAuth, async (c) => {
    const parsed = MatchListQuerySchema.safeParse(c.req.query())
    if (!parsed.success) {
      return c.json(
        errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(parsed.error.issues)),
        422,
      )
    }

    const { wishId, listingId, limit } = parsed.data
    const userId = c.get('userId')

    try {
      // schema 的 refine 保证二者恰好有一个，这里只是把它落成一个明确的分支。
      if (wishId !== undefined) return c.json(await service.listByWish(userId, wishId, limit), 200)
      if (listingId !== undefined) {
        return c.json(await service.listByListing(userId, listingId, limit), 200)
      }
    } catch (error) {
      return toErrorResponse(c, error)
    }

    // 不可达：refine 已排除"两个都缺"。
    return c.json(
      errorBody('VALIDATION_FAILED', '请求参数不合法', [
        { field: 'wishId', message: 'wishId 与 listingId 必须恰好提供一个' },
      ]),
      422,
    )
  })

  return app
}
