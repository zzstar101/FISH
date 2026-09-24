import {
  AdminAuditLogsQuerySchema,
  AdminListingsQuerySchema,
  AdminModerationQueueQuerySchema,
  AdminTargetIdSchema,
  AdminTransactionQuerySchema,
  AdminUsersQuerySchema,
} from '@fish/contracts/admin/schema'
import { ModerationDecisionInputSchema } from '@fish/contracts/moderation/schema'
import {
  AdminReportHandleInputSchema,
  AdminReportQueueQuerySchema,
} from '@fish/contracts/reports/schema'
import { errorBody, validationDetails } from '@fish/contracts/system/error'
import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import type { ReportService } from '../reports/service'
import { ReportServiceError } from '../reports/service'
import { AdminError } from './errors'
import type { AdminService } from './service'

export type AdminRouterOptions = {
  service: AdminService
  /**
   * 举报服务（#73）：Admin 侧的举报队列 / 详情 / 处理只经过它。
   * 用户端 POST /reports 走独立的 reports router，不经过本文件的两道守卫。
   */
  reportsService: ReportService
  /**
   * 认证守卫（`auth` 模块提供）：所有 `/admin/*` 先过它（401 `UNAUTHENTICATED`）。
   * 在 router 内 `use('*')` 应用，配合 `requireAdmin` 组成设计 §3.2 的双层守卫——
   * 普通用户被拦在 `FORBIDDEN`，不能靠修改前端状态绕过后台。
   */
  requireAuth: MiddlewareHandler<{ Variables: AuthVariables }>
  /** Admin 守卫（本模块 `middleware.ts`）：已登录但非 Admin → 403 `FORBIDDEN`。 */
  requireAdmin: MiddlewareHandler<{ Variables: AuthVariables }>
}

function zodValidationFailure(
  c: Context,
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
) {
  return c.json(errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(issues)), 422)
}

/**
 * 路径参数 `:userId` / `:listingId` 必须是合法 UUID：否则会被绑到 uuid 列上，
 * PostgreSQL 报 `invalid input syntax for type uuid` → 500。管理后台对非 UUID 一律 404。
 */
function requireTargetId(c: Context, name: string): string {
  const parsed = AdminTargetIdSchema.safeParse(c.req.param(name))
  if (!parsed.success) throw new AdminError('ADMIN_NOT_FOUND', 404, '目标不存在')
  return parsed.data
}

/** 业务异常 → 契约错误信封；其它异常继续上抛给 `app.onError`。 */
function toErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof AdminError) {
    return c.json(errorBody(error.code, error.message), error.status)
  }
  throw error
}

/**
 * 举报 service 异常 → 契约错误信封（与 AdminError 同形状：`{ code, message }`）。
 *
 * 同时认 `AdminError`：`requireTargetId`（非 UUID → 404）写在 try 内最自然，
 * 只认 ReportServiceError 会让 AdminError 一路逃到 app.onError 变成 500。
 */
function toReportErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof ReportServiceError) {
    return c.json(errorBody(error.code, error.message), error.status)
  }
  if (error instanceof AdminError) {
    return c.json(errorBody(error.code, error.message), error.status)
  }
  throw error
}

/**
 * Admin router。挂载点在 `apps/api/src/app.ts` 的 `/admin`（根级），router 内部用 `/me` 等。
 *
 * `router.use('*')` 两道守卫覆盖**全部** `/admin/*` 入口（设计 §3.2：“每个 Admin API 入口
 * 额外执行 requireAdmin”），新加端点不会忘挂。
 */
export function createAdminRouter(options: AdminRouterOptions) {
  const { service, reportsService } = options
  const router = new Hono<{ Variables: AuthVariables }>()

  router.use('*', options.requireAuth)
  router.use('*', options.requireAdmin)

  router.get('/me', async (c) => {
    try {
      return c.json(await service.getMe(c.get('me')), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.get('/users', async (c) => {
    const parsed = AdminUsersQuerySchema.safeParse(c.req.query())
    if (!parsed.success) return zodValidationFailure(c, parsed.error.issues)

    try {
      return c.json(await service.listUsers(parsed.data), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.get('/users/:userId', async (c) => {
    try {
      const userId = requireTargetId(c, 'userId')
      return c.json(await service.getUserDetail(userId), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.get('/listings', async (c) => {
    const parsed = AdminListingsQuerySchema.safeParse(c.req.query())
    if (!parsed.success) return zodValidationFailure(c, parsed.error.issues)

    try {
      return c.json(await service.listListings(parsed.data), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.get('/listings/:listingId', async (c) => {
    try {
      const listingId = requireTargetId(c, 'listingId')
      return c.json(await service.getListingDetail(listingId), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.get('/overview', async (c) => {
    try {
      return c.json(await service.getOverview(), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.get('/moderation/queue', async (c) => {
    const parsed = AdminModerationQueueQuerySchema.safeParse(c.req.query())
    if (!parsed.success) return zodValidationFailure(c, parsed.error.issues)
    try {
      return c.json(await service.listModerationQueue(parsed.data), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.get('/moderation/:recordId', async (c) => {
    try {
      return c.json(await service.getModerationDetail(requireTargetId(c, 'recordId')), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.post('/moderation/:recordId/decision', async (c) => {
    const input = ModerationDecisionInputSchema.safeParse(await c.req.json().catch(() => null))
    if (!input.success) return zodValidationFailure(c, input.error.issues)
    const requestId = c.req.header('Idempotency-Key')?.trim()
    if (!requestId || requestId.length > 128) {
      return c.json(errorBody('VALIDATION_FAILED', '缺少有效的 Idempotency-Key'), 422)
    }
    try {
      return c.json(
        await service.decideModeration({
          recordId: requireTargetId(c, 'recordId'),
          actorUserId: c.get('userId'),
          decision: input.data.decision,
          reason: input.data.reason,
          requestId,
        }),
        200,
      )
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.get('/transactions', async (c) => {
    const parsed = AdminTransactionQuerySchema.safeParse(c.req.query())
    if (!parsed.success) return zodValidationFailure(c, parsed.error.issues)
    try {
      return c.json(await service.listAdminTransactions(parsed.data), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  router.get('/audit-logs', async (c) => {
    const parsed = AdminAuditLogsQuerySchema.safeParse(c.req.query())
    if (!parsed.success) return zodValidationFailure(c, parsed.error.issues)

    try {
      return c.json(await service.listAuditLogs(parsed.data), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  // --- 举报（#73）：队列 / 详情 / 处理 -------------------------------------
  // 只调 reports service；治理动作（下架 / 恢复 / 限制 / 封禁）是另外的端点，
  // 由本 router 后续版本注册（grill Q9：处理举报 ≠ 处罚用户）。
  //
  // 注意：本文件全部注册「相对路径」（`/reports` 而不是 ADMIN_ROUTES.reports）——app.ts 用
  // `app.route('/admin', router)` 挂载，绝对路径会变成 /admin/admin/reports。ADMIN_ROUTES
  // 是客户端契约口径（web 请求用），controller 侧沿用 moderation 先例手写相对路径。

  router.get('/reports', async (c) => {
    const parsed = AdminReportQueueQuerySchema.safeParse(c.req.query())
    if (!parsed.success) return zodValidationFailure(c, parsed.error.issues)

    try {
      return c.json(await reportsService.listAdminReports(parsed.data), 200)
    } catch (error) {
      return toReportErrorResponse(c, error)
    }
  })

  // 注册在详情之前：`/reports/:reportId/handle` 比 `/reports/:reportId` 多一段
  // 静态段，放在前面可以让任何路由实现都优先匹配它，不依赖 Hono 的静态段优先语义。
  router.post('/reports/:reportId/handle', async (c) => {
    const input = AdminReportHandleInputSchema.safeParse(await c.req.json().catch(() => null))
    if (!input.success) return zodValidationFailure(c, input.error.issues)

    try {
      await reportsService.handleReport({
        reportId: requireTargetId(c, 'reportId'),
        actorUserId: c.get('userId'),
        result: input.data.result,
        reason: input.data.reason,
      })
      return c.body(null, 204)
    } catch (error) {
      return toReportErrorResponse(c, error)
    }
  })

  router.get('/reports/:reportId', async (c) => {
    try {
      return c.json(await reportsService.getAdminReport(requireTargetId(c, 'reportId')), 200)
    } catch (error) {
      return toReportErrorResponse(c, error)
    }
  })

  // 未匹配的 `/admin/*` 也走契约错误信封（设计 §8）：Hono 默认返回 `text/plain` 的
  // `404 Not Found`，web 的 api-client 会把它归一成 `INTERNAL_ERROR`，客户端拿不到稳定错误码。
  //
  // 不用 `router.notFound(...)`：子应用的 notFound 不会经 `app.route('/admin', router)` 生效
  // （实测 unmatched 路径仍是 text/plain），所以用注册在最后、匹配任意方法任意路径的 catch-all。
  // 守卫在 `use('*')` 里先执行，因此该兜底只对「已过 requireAuth + requireAdmin」的请求生效。
  //
  // 代价：路径存在但方法不匹配（如 `POST /admin/users`）也落到这里拿 404。Hono 在本项目里本来
  // 也不会返回 405（改动前实测 `POST /admin/me` 同样是 404），因此这是既有语义，不是本次引入的回归。
  router.all('*', (c) => c.json(errorBody('ADMIN_NOT_FOUND', '目标不存在'), 404))

  return router
}
