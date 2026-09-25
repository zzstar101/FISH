import { errorBody } from '@fish/contracts/system/error'
import type { MiddlewareHandler } from 'hono'
import type { GovernanceStore, RestrictionScope } from './store'

/**
 * 守卫只依赖 `userId` 这一个 context 字段，所以它的上下文类型比 `AuthVariables` 宽：
 * wishes 等模块的 Variables 就是 `{ userId: string }`，能直接复用同一个守卫实例。
 */
export type RestrictionVariables = { userId: string }

/**
 * 写入口守卫（#73 治理半场 PR3，验收标准 4）：「受限用户直接调用 API 仍被限制」。
 *
 * 做成 Hono 中间件而不是 service 内部的断言，是因为**入口必须可枚举**：
 * 每个受保护的写路由上显式挂一个 `options.guard.publish` / `options.guard.write`，
 * 审查时 grep 路由器文件就能看完所有被保护的入口，漏挂一个会立刻显眼。
 * 反过来，若把检查藏进 service，就得逐个读四个模块的业务代码才能确认覆盖面。
 *
 * 作用域（`RestrictionScope`）：
 * - `publish` → 发布入口。`PUBLISH_RESTRICT` 与 `BAN` 都挡。
 * - `write` → 留言 / 聊天。只挡 `BAN`；「限制发布」不扩大解释成禁言。
 *
 * 只读 userId 不读任何请求字段：伪造 `x-user-id` 之类的头不可能影响判定
 * （userId 由 requireAuth 从服务端会话写入 context）。
 */
export type RestrictionGuard = {
  publish: MiddlewareHandler<{ Variables: RestrictionVariables }>
  write: MiddlewareHandler<{ Variables: RestrictionVariables }>
}

const MESSAGES: Record<RestrictionScope, string> = {
  publish: '账号被限制发布，暂不能发布或修改商品',
  write: '账号被封禁，暂不能留言或发送消息',
}

export function createRestrictionGuard(options: {
  store: Pick<GovernanceStore, 'hasActiveRestriction'>
}): RestrictionGuard {
  const guard =
    (scope: RestrictionScope): MiddlewareHandler<{ Variables: RestrictionVariables }> =>
    async (c, next) => {
      const userId = c.get('userId')
      if (!userId) {
        // requireAuth 先跑，正常到不了这里；兜底而不是放行（放行等于守卫失效）。
        return c.json(errorBody('UNAUTHENTICATED', '请先登录'), 401)
      }
      if (await options.store.hasActiveRestriction(userId, scope)) {
        return c.json(errorBody('USER_RESTRICTED', MESSAGES[scope]), 403)
      }
      await next()
    }

  return { publish: guard('publish'), write: guard('write') }
}
