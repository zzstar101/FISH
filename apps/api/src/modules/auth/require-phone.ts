import type { AuthErrorCode } from '@fish/contracts/auth/session'
import { errorBody } from '@fish/contracts/system/error'
import type { MiddlewareHandler } from 'hono'
import type { AuthVariables } from './middleware'

const PHONE_REQUIRED: AuthErrorCode = 'PHONE_REQUIRED'

/**
 * 「必须已绑定手机号」门禁（#514）。权限矩阵冻结在 `@fish/contracts/auth/phone` 的注释里：
 * 新建商品、重新上架、发布求购三处挂它，其余写入口不挂。
 *
 * 由 `app.ts` 注入各 router（同 `guard` 的做法，router 单测可换替身）。
 * 只读 `requireAuth` 放进 context 的 `me.phoneBound`，不查库。挂载顺序约定
 * `requireAuth → requirePhoneBound → guard.publish`：放在治理守卫之前，被拦的请求不必先开
 * `withWriteGuard` 的事务。
 *
 * 不并进 `requireAuth`：那是全部已认证请求的入口，会把留言 / 聊天 / 交易一起挡掉；也不进
 * `governance/guard.ts`：治理域不该知道手机号。
 */
export const requirePhoneBound: MiddlewareHandler<{ Variables: AuthVariables }> = async (
  c,
  next,
) => {
  // `!== true` 而不是 `!phoneBound`：requireAuth 漏挂时 `me` 为 undefined，按未绑定拒绝而不是放行
  if (c.get('me')?.phoneBound !== true) {
    return c.json(errorBody(PHONE_REQUIRED, '发布前请先绑定手机号'), 403)
  }
  await next()
}
