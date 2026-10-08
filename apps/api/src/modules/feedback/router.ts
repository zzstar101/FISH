import { FeedbackCreateInputSchema, FeedbackMineQuerySchema } from '@fish/contracts/feedback/schema'
import { errorBody, validationDetails } from '@fish/contracts/system/error'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { FeedbackService } from './service'
import { FeedbackServiceError } from './service'

type FeedbackVariables = { userId: string }
type FeedbackContext = Context<{ Variables: FeedbackVariables }>

export interface FeedbackRouterOptions {
  service: FeedbackService
  /** 已登录用户 id（由挂载点的 requireAuth 保证存在）。 */
  getUserId: (context: FeedbackContext) => string
}

/**
 * 用户端反馈路由：POST /feedback（提交）、GET /feedback/mine（我的反馈）。
 *
 * 全部需要登录（挂在 `auth.requireAuth` 之后，见 app.ts）：匿名反馈无法回传结果，也无从频控。
 * **刻意不挂 `guard.write`**：被限制 / 封禁的用户恰恰最需要一个申诉与求助的渠道；滥用由
 * 24 小时频控兜底。管理端端点在 modules/admin/router.ts（同一套 requireAdmin 守卫）。
 */
export function createFeedbackRouter(options: FeedbackRouterOptions) {
  const router = new Hono<{ Variables: FeedbackVariables }>()
  const { service, getUserId } = options

  const fail = (err: unknown, ctx: FeedbackContext) => {
    if (err instanceof FeedbackServiceError) {
      return ctx.json(errorBody(err.code, err.message), err.status)
    }
    return undefined
  }

  // 相对路径：app.ts 用 `app.route('/feedback', router)` 挂载（先例：reports router）。
  router.post('/', async (ctx) => {
    let raw: unknown
    try {
      raw = await ctx.req.json()
    } catch {
      return ctx.json(errorBody('VALIDATION_FAILED', '请求体不是合法 JSON'), 422)
    }
    const parsed = FeedbackCreateInputSchema.safeParse(raw)
    if (!parsed.success) {
      return ctx.json(
        errorBody('VALIDATION_FAILED', '请求参数校验失败', validationDetails(parsed.error.issues)),
        422,
      )
    }
    try {
      const response = await service.createFeedback(getUserId(ctx), parsed.data)
      return ctx.json(response, response.created ? 201 : 200)
    } catch (err) {
      return fail(err, ctx) ?? Promise.reject(err)
    }
  })

  router.get('/mine', async (ctx) => {
    const parsed = FeedbackMineQuerySchema.safeParse(ctx.req.query())
    if (!parsed.success) {
      return ctx.json(
        errorBody('VALIDATION_FAILED', '请求参数校验失败', validationDetails(parsed.error.issues)),
        422,
      )
    }
    try {
      return ctx.json(await service.listMine(getUserId(ctx), parsed.data))
    } catch (err) {
      return fail(err, ctx) ?? Promise.reject(err)
    }
  })

  return router
}
