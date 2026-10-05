import type { AccountDeletionState } from '@fish/contracts/account-deletion/schema'
import { errorBody } from '@fish/contracts/system/error'
import type { MiddlewareHandler } from 'hono'
import type { SessionCookie } from '../auth/session'
import { ACCOUNT_DELETION_PENDING_MESSAGE, isAccountDeletionBlockedWrite } from './write-policy'

/**
 * 冷静期写拦截的**第二个执行点**（Issue #464，对抗性审查 B2）。
 *
 * ## 为什么需要它
 *
 * 主执行点在 `auth/middleware.ts` 的 `requireAuth` 里，但有几条写入口**故意不挂**
 * `requireAuth`：它们匿名可用，同时通过 `resolveViewerId` 解析**可选**身份
 * （拍照搜图、推荐事件上报）。`resolveViewerId` 只在 `DELETED` 时返回 null，
 * `DELETION_REQUESTED` 时仍返回真实 userId，于是冷静期内这些入口：
 *
 * - 不会经过主执行点（没挂 `requireAuth`）；
 * - 却带着真实归属把数据写进库（实测 `POST /recommendations/events` 回 202，
 *   并落下一行带该 user_id 的 `recommendation_events`）。
 *
 * 这与冻结口径「申请之后一切写操作都拒」不符，也会继续投递 `REFRESH_USER_INTEREST`。
 *
 * ## 为什么不是把它们加进白名单的例外，而是补一层守卫
 *
 * 它们**确实**是公开入口（匿名可用），所以「公开写入口清单」不该把它们移出去（移出去
 * 会让那条反向自检用例变红，且描述失真）。正确做法是补一个「解析出身份之后」的检查点，
 * 复用同一份判据 `isAccountDeletionBlockedWrite`：白名单仍然只有一份，匿名请求不受影响
 * （读不到 cookie 就直接放行），只有「冷静期账号 + 写方法 + 不在白名单」才 403。
 *
 * 挂载点是 `app.ts` 里那几条 `app.route('/recommendations', …)` /
 * `app.route('/visual-search', …)` 之前 —— 与 `requireAuth` 一样由 Platform 统一接线。
 */
export function createOptionalIdentityDeletionGuard(deps: {
  cookie: SessionCookie
  /**
   * 令牌 → 账号状态。与 `requireAuth` 用**同一个** `AuthService['loadViewer']`：
   * 解析逻辑（会话有效性 + `DELETED` 收窄）只有一份，不存在第二个认证入口。
   */
  loadViewer: (token: string) => Promise<{ accountStatus: AccountDeletionState } | null>
}): MiddlewareHandler {
  return async (c, next) => {
    const token = deps.cookie.read(c)
    // 匿名：没有身份就无从谈起「注销态写拦截」，与冻结口径一致。
    if (!token) return next()

    const viewer = await deps.loadViewer(token)
    if (!viewer || viewer.accountStatus === 'ACTIVE') return next()

    if (!isAccountDeletionBlockedWrite({ method: c.req.method, path: c.req.path })) return next()

    // 与 `requireAuth` 同码同文案：端上只需认一个错误码。
    return c.json(errorBody('ACCOUNT_DELETION_PENDING', ACCOUNT_DELETION_PENDING_MESSAGE), 403)
  }
}
