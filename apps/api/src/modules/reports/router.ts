import { ReportCreateInputSchema, ReportMineQuerySchema } from '@fish/contracts/reports/schema'
import { errorBody, validationDetails } from '@fish/contracts/system/error'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { ReportService } from './service'
import { ReportServiceError } from './service'

type ReportsVariables = { userId: string }
type ReportsContext = Context<{ Variables: ReportsVariables }>

export interface ReportsRouterOptions {
  service: ReportService
  /** 已登录用户 id（由挂载点的 requireAuth 保证存在）。 */
  getUserId: (context: ReportsContext) => string
}

/**
 * 用户端举报路由：POST /reports（提交）、GET /reports/mine（我的举报）。
 *
 * 全部需要登录（挂载在 `auth.requireAuth` 之后，见 app.ts）——匿名举报会变成
 * 无法追溯的垃圾单，而且 `reporter_id` 非空。Admin 侧端点不在本文件，
 * 见 modules/admin/router.ts（同一套 requireAdmin 守卫）。
 */
export function createReportsRouter(options: ReportsRouterOptions) {
  const router = new Hono<{ Variables: ReportsVariables }>()
  const { service, getUserId } = options

  /** 统一把 service 层错误翻成 HTTP 信封（与 admin router 的 toErrorResponse 同形状）。 */
  const fail = (err: unknown, ctx: ReportsContext) => {
    if (err instanceof ReportServiceError) {
      return ctx.json(errorBody(err.code, err.message), err.status)
    }
    return undefined
  }

  // 注意：这里注册的是「相对路径」`/` 与 `/mine`，因为 app.ts 里用
  // `app.route('/reports', router)` 挂载（先例：wishes / notifications router）。
  // 契约里的 REPORT_ROUTES 是绝对路径（客户端请求用），二者故意分开：controller
  // 不知道挂载点，数据契约也不知道路由器的形态。写绝对路径会变成 /reports/reposts。
  router.post('/', async (ctx) => {
    let raw: unknown
    try {
      raw = await ctx.req.json()
    } catch {
      return ctx.json(errorBody('VALIDATION_FAILED', '请求体不是合法 JSON'), 422)
    }
    const parsed = ReportCreateInputSchema.safeParse(raw)
    if (!parsed.success) {
      return ctx.json(
        errorBody('VALIDATION_FAILED', '请求参数校验失败', validationDetails(parsed.error.issues)),
        422,
      )
    }

    const input = parsed.data
    try {
      const response = await service.createReport(getUserId(ctx), {
        targetType: input.targetType,
        targetId: input.targetId,
        reason: input.reason,
        detailText: input.detailText ?? null,
      })
      // 重复举报（同一举报人 + 同一目标的未决单已存在）返回 200 + created:false，
      // 把已存在的那张单原样交回前端展示「已受理」，不新增行、也不报冲突。
      return ctx.json(response, response.created ? 201 : 200)
    } catch (err) {
      return fail(err, ctx) ?? Promise.reject(err)
    }
  })

  router.get('/mine', async (ctx) => {
    const parsed = ReportMineQuerySchema.safeParse(ctx.req.query())
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
