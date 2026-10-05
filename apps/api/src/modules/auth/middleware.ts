import type { AccountDeletionState } from '@fish/contracts/account-deletion/schema'
import type { Me } from '@fish/contracts/auth/user'
import { errorBody } from '@fish/contracts/system/error'
import { decodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
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
 * 冷静期内的写拦截判据（#464）：给「方法 + 路径 + 账号状态」，回答「是否拒绝」。
 *
 * 判据本身（白名单里放哪些路径）属于 account-deletion 域，见
 * `apps/api/src/modules/account-deletion/write-policy.ts`；这里只负责**在正确的时机问它**。
 * 分开的理由：`requireAuth` 是全部已认证请求的唯一入口，拦截挂在这里能保证「漏挂一个业务
 * 路由」不会漏网，而白名单又必须能被单测直接枚举（见那个文件的 `isAccountDeletionBlockedWrite`）。
 */
export type AccountDeletionWriteGuard = (input: {
  method: string
  path: string
  accountStatus: AccountDeletionState
}) => boolean

/**
 * 认证守卫。按 CONTRIBUTING §2（Coast-87 段：「根路由由 zzstar101 统一接线」），
 * 挂载由 Platform 在 `app.ts` 统一做（例如 `app.use('/wishes/*', requireAuth)`），
 * 模块自己不挂，避免漏挂。
 *
 * 401 + `UNAUTHENTICATED` 是前端唯一的「跳登录」信号（见 issue #3 冻结契约第 6 节）。
 */
export function createRequireAuth(deps: {
  cookie: SessionCookie
  service: AuthService
  /**
   * 已认证用户的「心跳」回调（#359 第五点）：在线态的口径是「最近一次已认证活动」，
   * 而这条中间件是**全部**已认证 HTTP 请求的唯一入口，所以在这里记时刻。
   * 拿不到身份（401）不回调 —— 没登录的请求不构成任何人的在线证据。
   */
  onAuthenticated?: (userId: string) => void
  /**
   * #464 的写拦截（可选依赖：不传就完全不拦，测试与不关心注销的装配不必构造它）。
   *
   * 只对**已认证**请求生效（未登录的请求在上一行就 401 了），且拦截发生在
   * `onAuthenticated` 之后 —— 被拒的写请求仍然算「人在线」，否则冷静期一开始用户就会被
   * 显示成离线。
   *
   * 守卫本身只回答「这条路径算不算写」，**是否要拦由这里按账号状态决定**：
   * 只有 `DELETION_REQUESTED` 才进入判断。漏掉这层状态门会让所有正常账号的写请求一起被拒，
   * 这是本单最容易犯、也最容易被「只测了注销态」的用例漏掉的错误。
   */
  accountDeletionWriteGuard?: AccountDeletionWriteGuard
}): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const token = deps.cookie.read(c)
    // `loadViewer` 而不是 `loadMe`：同样的查询，顺便拿到账号状态；已注销（DELETED）的账号
    // 在这里与「令牌无效」同码 401，不存在「注销后仍能以旧会话读写」的通路。
    const viewer = token ? await deps.service.loadViewer(token) : null
    if (!viewer) return c.json(errorBody('UNAUTHENTICATED', '请先登录'), 401)

    const userId = decodePublicId(PUBLIC_ID_PREFIX.user, viewer.me.id)
    c.set('userId', userId)
    c.set('me', viewer.me)
    deps.onAuthenticated?.(userId)

    if (
      viewer.accountStatus !== 'ACTIVE' &&
      deps.accountDeletionWriteGuard?.({
        method: c.req.method,
        path: c.req.path,
        accountStatus: viewer.accountStatus,
      })
    ) {
      // 403 + `ACCOUNT_DELETION_PENDING`：端上据此提示「注销申请处理中，暂不能发布 / 留言 /
      // 聊天 / 交易；可先撤回申请」，并可跳注销状态页。
      return c.json(
        errorBody('ACCOUNT_DELETION_PENDING', '注销申请处理中，暂不能进行该操作，可先撤回申请'),
        403,
      )
    }

    await next()
  }
}
