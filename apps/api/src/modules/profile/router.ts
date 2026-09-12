import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import type { ProfileService } from './service'

export type ProfileRouterOptions = {
  service: ProfileService
  /**
   * 个人中心全是本人数据，没有匿名路径，整条挂 requireAuth。
   * 认证守卫已把 `Me`（含 campus 脏值回退）写入 context，user 块直接取它，
   * 不再重复查询 users 表——与 auth 的 toMe 映射不会漂移。
   */
  requireAuth: MiddlewareHandler<{ Variables: AuthVariables }>
}

/** 挂载点是 /profile（app.ts），router 内部用 /。 */
export function createProfileRouter({ service, requireAuth }: ProfileRouterOptions) {
  const app = new Hono<{ Variables: AuthVariables }>()

  app.get('/', requireAuth, async (c: Context<{ Variables: AuthVariables }>) => {
    return c.json(await service.getProfile(c.get('me')), 200)
  })

  return app
}
