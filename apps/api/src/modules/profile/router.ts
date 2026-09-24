import {
  profileUpdateRequestSchema,
  profileUpdateResponseSchema,
} from '@fish/contracts/profile/schema'
import { errorBody, validationDetails } from '@fish/contracts/system/error'
import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import type { RestrictionGuard } from '../governance/guard'
import { UploadServiceError } from '../uploads/service'
import type { ProfileService } from './service'

export type ProfileRouterOptions = {
  service: ProfileService
  /**
   * 个人中心全是本人数据，没有匿名路径，整条挂 requireAuth。
   * 认证守卫已把 `Me`（含 avatarUrl 脏值回退）写入 context，user 块直接取它，
   * 不再重复查询 users 表——与 auth 的 toMe 映射不会漂移。
   */
  requireAuth: MiddlewareHandler<{ Variables: AuthVariables }>
  /** #73 治理守卫：改资料前检查封禁（个人资料写入属 `write` 作用域）。 */
  guard: RestrictionGuard
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    return null
  }
}

/** 挂载点是 /profile（app.ts），router 内部用 /。 */
export function createProfileRouter({ service, requireAuth, guard }: ProfileRouterOptions) {
  const app = new Hono<{ Variables: AuthVariables }>()

  app.get('/', requireAuth, async (c: Context<{ Variables: AuthVariables }>) => {
    return c.json(await service.getProfile(c.get('me')), 200)
  })

  /**
   * #86 B：编辑资料（昵称 / 头像）。读写共用同一个资源路径，只差方法。
   *
   * 只回更新后的 `Me`，不回整个聚合视图：端上拿到就覆盖 store，页面无需重拉。
   * 头像的**对象键**在这里被换成绝对 URL（service 内复用上传域的 confirm 校验），
   * 因此 422 必须按上传域的错误码原样透出——端上「发布商品」的错误处理直接复用。
   */
  app.patch('/', requireAuth, guard.write, async (c: Context<{ Variables: AuthVariables }>) => {
    const parsed = profileUpdateRequestSchema.safeParse(await readJson(c))
    if (!parsed.success) {
      // 契约 §3：VALIDATION_FAILED 必须带 details，前端据此把错误定位到输入框。
      return c.json(
        errorBody('VALIDATION_FAILED', '请求参数不合法', validationDetails(parsed.error.issues)),
        422,
      )
    }

    try {
      const user = await service.updateProfile(c.get('me'), parsed.data)
      return c.json(profileUpdateResponseSchema.parse({ user }), 200)
    } catch (error) {
      if (error instanceof UploadServiceError) {
        return c.json(errorBody(error.code, error.message, error.details), error.status)
      }
      throw error
    }
  })

  return app
}
