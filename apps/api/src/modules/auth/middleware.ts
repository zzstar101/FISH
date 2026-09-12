import type { Me } from '@fish/contracts/auth/user'
import { errorBody } from '@fish/contracts/system/error'
import type { MiddlewareHandler } from 'hono'
import type { AuthService } from './service'
import type { SessionCookie } from './session'

/**
 * 下游模块（#7 许愿 / #9 聊天 / #11 交易）写 `new Hono<{ Variables: AuthVariables }>()`
 * 即可类型安全地读取 `c.get('me')` / `c.get('userId')`。`me` 是 `Me` DTO，
 * **不含学号与密码哈希**，敏感字段在类型层面就无法泄漏。
 */
export type AuthVariables = { userId: string; me: Me }

/**
 * 认证守卫。按 CONTRIBUTING §2 第 6 条，根路由挂载由 Platform 统一在 `app.ts` 做
 * （例如 `app.use('/wishes/*', requireAuth)`），模块自己不挂，避免漏挂。
 *
 * 401 + `UNAUTHENTICATED` 是前端唯一的「跳登录」信号（契约第 6 条）。
 */
export function createRequireAuth(deps: {
  cookie: SessionCookie
  service: AuthService
}): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const token = deps.cookie.read(c)
    const me = token ? await deps.service.loadMe(token) : null
    if (!me) return c.json(errorBody('UNAUTHENTICATED', '请先登录'), 401)

    c.set('userId', me.id)
    c.set('me', me)
    await next()
  }
}
