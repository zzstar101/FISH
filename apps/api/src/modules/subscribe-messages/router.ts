import { SUBSCRIBE_MESSAGE_ROUTES } from '@fish/contracts/subscribe-messages/routes'
import { subscribeMessageGrantReportSchema } from '@fish/contracts/subscribe-messages/schema'
import { errorBody, validationDetails } from '@fish/contracts/system/error'
import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import type { RestrictionGuard } from '../governance/guard'
import { SubscribeMessageError, type SubscribeMessageService } from './service'

type SubscribeMessageVariables = AuthVariables
type SubscribeMessageContext = Context<{ Variables: SubscribeMessageVariables }>

/** 解析失败回 null：交给 schema 报 422，而不是让 JSON 解析异常变成 500（与 auth / #464 同构）。 */
async function readJson(c: SubscribeMessageContext): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    return null
  }
}

/** 业务异常 → 契约错误信封；其它异常继续上抛给 `app.onError`。 */
function toErrorResponse(c: SubscribeMessageContext, error: unknown): Response {
  if (error instanceof SubscribeMessageError) {
    return c.json(errorBody(error.code, error.message), error.status)
  }
  throw error
}

export type SubscribeMessagesRouterOptions = {
  service: SubscribeMessageService
  /** 与全站同一份 `requireAuth`（`auth.router` 里造的那个）。 */
  requireAuth: MiddlewareHandler<{ Variables: AuthVariables }>
  /** 封禁/限制状态下的写守卫（与 `POST /conversations/:id/messages` 同一道）。 */
  guard: RestrictionGuard
}

/**
 * 微信订阅消息的两个端点（#462）。
 *
 * ⚠️ 本 router 挂在根路径 `/`（两个端点分属 `/subscribe-messages/...` 与 `/me/...`，没有共同
 * 前缀），所以**逐路径挂**中间件、不用 `router.use('*', …)` —— 那会被 `app.route('/', sub)`
 * 提升成父 app 的全局中间件（本仓踩过的坑，见 `favorites/router.ts`）。
 */
export function createSubscribeMessagesRouter({
  service,
  requireAuth,
  guard,
}: SubscribeMessagesRouterOptions) {
  const router = new Hono<{ Variables: SubscribeMessageVariables }>()

  /**
   * 读模板配置。**不需要登录**：它对所有调用方是同一份静态配置、不含任何用户数据，
   * 而端上要在登录前就决定"这台手机上有没有这个能力"（契约注释同源）。
   */
  router.get(SUBSCRIBE_MESSAGE_ROUTES.config, (c) => c.json(service.config(), 200))

  /**
   * 上报 `wx.requestSubscribeMessage` 的结果。写路径，所以两道中间件都挂：
   * `requireAuth`（401）→ `guard.write`（被封禁/限制时 403）。
   */
  router.post(SUBSCRIBE_MESSAGE_ROUTES.grants, requireAuth, guard.write, async (c) => {
    const parsed = subscribeMessageGrantReportSchema.safeParse(await readJson(c))
    if (!parsed.success) {
      return c.json(
        errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(parsed.error.issues)),
        422,
      )
    }

    try {
      return c.json(await service.reportGrants(c.get('userId'), parsed.data), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  return router
}

export type SubscribeMessagesRouter = ReturnType<typeof createSubscribeMessagesRouter>
