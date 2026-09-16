import { errorBody } from '@fish/contracts/system/error'
import type { MiddlewareHandler } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import type { AdminStore } from './store'

/**
 * `requireAdmin`（设计 §3.2）：`requireAuth` 之后的第二道守卫。
 *
 * - 只从**服务端会话解析出的 userId**（`requireAuth` 写入 context）查角色，
 *   禁止信任请求头、URL 参数、前端状态或可伪造的 Cookie 字段。
 * - 已登录但非 Admin → 稳定的 `FORBIDDEN` / 403（普通用户访问任何 `/admin/*` 都返回它，
 *   不能靠修改前端状态绕过——前端路由守卫只负责体验）。
 *
 * 挂载方式与 /wishes 一致：根路由由 `apps/api/src/app.ts` 统一接线——
 * `app.use('/admin/*', auth.requireAuth)` 先过认证，进入本 router 后 `router.use('*',
 * requireAdmin)` 覆盖全部 `/admin/*`（设计 §3.2："每个 Admin API 入口额外执行 requireAdmin"）。
 */
export function createRequireAdmin(options: {
  store: Pick<AdminStore, 'isAdmin'>
}): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const userId = c.get('userId')
    // 正常情况下 requireAuth 已先拦截未登录；这里兜底（模块脱离 app.ts 自用时不会漏）。
    if (!userId) return c.json(errorBody('UNAUTHENTICATED', '请先登录'), 401)

    if (!(await options.store.isAdmin(userId))) {
      return c.json(errorBody('FORBIDDEN', '无管理权限'), 403)
    }
    await next()
  }
}
