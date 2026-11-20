import type { AccountDeletionState } from '@fish/contracts/account-deletion/schema'
import type { Me } from '@fish/contracts/auth/user'
import type { Db } from '@fish/db/client'
import { users } from '@fish/db/schema/users'
import { and, eq } from 'drizzle-orm'
import { AuthError } from './errors'
import { toMe } from './me'
import type { Sessions } from './session'
import { isUniqueViolation } from './unique'

export function createAuthService(deps: { db: Db; sessions: Sessions }) {
  const { db, sessions } = deps

  return {
    async logout(token: string | undefined): Promise<void> {
      if (token) await sessions.revoke(token)
    },

    /**
     * 认证守卫用：令牌 → 当前用户；无效、过期或**已注销**返回 null。
     *
     * #464：`DELETED` 的账号一律当作未登录。去标识化那一刻凭据已被清空、会话已被删光
     * （见 `apps/worker/src/jobs/account-deletion/purge.ts`），所以正常路径下不会有这样的
     * 会话；这里再判一次是**失败关闭**的兜底 —— 万一有残留行（例如去标识化之后有人手工
     * 写回一条会话，或将来新增了别的会话来源），也不存在任何「注销后复活」的通路。
     *
     * 与 `resolveViewerId`（匿名可读路径）共用同一实现，所以「复活」在两条入口上同时被堵死。
     */
    loadMe: async (token: string): Promise<Me | null> => (await loadViewer(token))?.me ?? null,

    /**
     * 令牌 → 当前用户 **+ 账号状态**（#464 的写拦截需要它）。
     *
     * 与 `loadMe` 共用同一次查询：守卫是**每个**已认证请求的必经之路，多查一次库是不可接受
     * 的代价；而状态本来就在这一行上，白拿。这也保证「注销态」不会成为第二个认证入口。
     */
    loadViewer,

    /**
     * 绑定手机号（#86 C 节）：phone code（stub 下即明文手机号）→ 写 `users.phone`。
     * 只追加绑定，不动 session；唯一索引兜底并发，冲突报 409。
     * 冻结的语义：同一用户重复提交同一号码 = 幂等成功（UPDATE 命中自身行，不撞唯一索引）。
     *
     * 已知缺口（**不在 #204 范围**，规则待 #86 冻结）：这里没有 `phone IS NULL` 守卫，所以
     * 再绑定一个**不同**号码会直接覆盖旧号（因为手机号来自平台核验，覆盖不算冒用，但既无审计
     * 也无确认步）；解绑则确实没有通路（列不清空）。要收紧成「首次绑定后不可换绑」或「换绑需
     * 显式确认」都得先由产品冻结规则，不在本单顺手加门槛。
     *
     * 返回 `false` = **账号已不在可写状态**（`account_status !== 'ACTIVE'`），一行都没写。
     * 路由据此回 403 `ACCOUNT_DELETION_PENDING`。
     *
     * 为什么条件 UPDATE 而不是相信守卫（#204 评审 P1）：冷静期拦截（#464）在 `requireAuth` 里问
     * 的是**请求进入那一刻**的账号状态，而这条链路中间要等微信上游（最坏 20s）。用户完全可能
     * 在这 20s 里从另一个页面/设备提交注销申请 —— 守卫早已跑过，等到这里再无条件 UPDATE 就把
     * 号码写进了冷静期的账号。把状态并进 WHERE 让「检查」和「写」是同一条语句，窗口才是 0；
     * 分两次查再判仍有窗口，只是更小。
     */
    async bindPhone(userId: string, phone: string): Promise<boolean> {
      try {
        const updated = await db
          .update(users)
          .set({ phone })
          .where(and(eq(users.id, userId), eq(users.accountStatus, 'ACTIVE')))
          .returning({ id: users.id })
        return updated.length > 0
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new AuthError('PHONE_ALREADY_BOUND', 409, '该手机号已绑定其他账号')
        }
        throw error
      }
    },
  }

  /**
   * 令牌 → 当前用户 + 账号状态（#464 的写拦截需要后者）。
   *
   * 与 `loadMe` 共用同一次查询：守卫是**每个**已认证请求的必经之路，多查一次库是不可接受的
   * 代价，而状态本来就在这一行上。`DELETED` 在这里被收窄掉（不可能是「当前登录者」），
   * 于是两条入口 —— `requireAuth` 与匿名可读的 `resolveViewerId` —— 同时失效。
   */
  async function loadViewer(
    token: string,
  ): Promise<{ me: Me; accountStatus: AccountDeletionState } | null> {
    const session = await sessions.resolve(token)
    if (!session) return null

    const rows = await db.select().from(users).where(eq(users.id, session.userId)).limit(1)
    const row = rows[0]
    if (!row) return null
    if (row.accountStatus === 'DELETED') return null
    return { me: toMe(row), accountStatus: row.accountStatus }
  }
}

export type AuthService = ReturnType<typeof createAuthService>
