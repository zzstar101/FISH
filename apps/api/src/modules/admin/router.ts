import {
  AdminAuditLogsQuerySchema,
  AdminListingsQuerySchema,
  AdminTargetIdSchema,
  AdminUsersQuerySchema,
} from '@fish/contracts/admin/schema'
import { errorBody, validationDetails } from '@fish/contracts/system/error'
import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import { AdminError } from './errors'
import type { AdminService } from './service'

export type AdminRouterOptions = {
  service: AdminService
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
 * Admin router。挂载点在 `apps/api/src/app.ts` 的 `/admin`（根级），router 内部用 `/me` 等。
 *
 * `router.use('*')` 两道守卫覆盖**全部** `/admin/*` 入口（设计 §3.2：“每个 Admin API 入口
 * 额外执行 requireAdmin”），新加端点不会忘挂。
 */
export function createAdminRouter(options: AdminRouterOptions) {
  const { service } = options
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

  router.get('/audit-logs', async (c) => {
    const parsed = AdminAuditLogsQuerySchema.safeParse(c.req.query())
    if (!parsed.success) return zodValidationFailure(c, parsed.error.issues)

    try {
      return c.json(await service.listAuditLogs(parsed.data), 200)
    } catch (error) {
      return toErrorResponse(c, error)
    }
  })

  // 未匹配的 `/admin/*` 也走契约错误信封（设计 §8）：Hono 默认返回 `text/plain` 的
  // `404 Not Found`，web 的 api-client 会把它归一成 `INTERNAL_ERROR`，客户端拿不到稳定错误码。
  //
  // 不用 `router.notFound(...)`：子应用的 notFound 不会经 `app.route('/admin', router)` 生效
  // （实测 unmatched 路径仍是 text/plain），所以用注册在最后、匹配任意方法任意路径的 catch-all。
  // 守卫在 `use('*')` 里先执行，因此该兜底只对「已过 requireAuth + requireAdmin」的请求生效。
  router.all('*', (c) => c.json(errorBody('ADMIN_NOT_FOUND', '目标不存在'), 404))

  /** 供测试/未来写操作的 body 读取与错误翻译复用导出。 */
  return router
}
