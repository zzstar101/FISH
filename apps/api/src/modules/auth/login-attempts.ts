import type { Db } from '@fish/db/client'
import { authLoginAttempts } from '@fish/db/schema/auth-attempts'
import { eq, sql } from 'drizzle-orm'

/**
 * 口令登录的失败计数与锁定（#132）。
 *
 * 阈值口径沿用 #70 面交码：5 次失败锁 10 分钟。一处刻意的差异：这里是**滚动窗口内**累计
 * （出窗即新一代），面交码是"累计不清零、重签发才清零"——凭证会重签发、账号不会，
 * 不清零会让长期手滑的正常用户在任何时点突然被锁。
 *
 * 时间判定一律用 **DB 时钟**（`now()`），不用应用时钟：#125 的同一论证，若由应用时钟写、
 * 由 DB 时钟读，偏移会直接改变实际锁定时长。
 *
 * 并发：`recordFailure` 先 `SELECT … FOR UPDATE` 锁住该行，再在**同一事务**里写回。
 * 跨事务的先读后写正是 #125 首轮审查抓出的 TOCTOU——那样 5 个并行失败请求可以把
 * "最多 5 次"放大成任意多次。
 */
export const LOGIN_MAX_ATTEMPTS = 5
export const LOGIN_LOCK_SECONDS = 10 * 60
export const LOGIN_WINDOW_SECONDS = 10 * 60

export function createLoginAttemptStore(db: Db) {
  return {
    /**
     * 口令校验**之前**的查锁：普通读，不加行锁。
     *
     * 与 `recordFailure` 之间存在窗口——最坏情况下多放一个并发请求去跑 argon2 校验。
     * 本模块保证的不变量是"允许的失败次数"，不是"锁定期内绝不执行口令校验"。
     */
    async isLocked(principal: string): Promise<boolean> {
      const rows = await db
        .select({ locked: sql<boolean>`${authLoginAttempts.lockedUntil} > now()` })
        .from(authLoginAttempts)
        .where(eq(authLoginAttempts.principal, principal))
        .limit(1)
      return rows[0]?.locked ?? false
    },

    /**
     * 记一次失败，返回本次之后是否处于锁定期。
     *
     * 已在锁定期内则**不**推进计数：否则持续的错误会把 10 分钟一路拖长，被锁的人永远出不来。
     */
    async recordFailure(principal: string): Promise<{ locked: boolean }> {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select({
            failedAttempts: authLoginAttempts.failedAttempts,
            lockedUntil: authLoginAttempts.lockedUntil,
            // 两个布尔都由 DB 时钟算出来，TS 只做算术，不参与时间比较。
            locked: sql<boolean>`${authLoginAttempts.lockedUntil} > now()`,
            inWindow: sql<boolean>`${authLoginAttempts.lastFailureAt} > now() - make_interval(secs => ${LOGIN_WINDOW_SECONDS}::int)`,
          })
          .from(authLoginAttempts)
          .where(eq(authLoginAttempts.principal, principal))
          .for('update')

        const prev = rows[0]
        const failedAttempts = prev
          ? prev.locked
            ? prev.failedAttempts
            : prev.inWindow
              ? prev.failedAttempts + 1
              : 1
          : 1
        const shouldLock = !prev?.locked && failedAttempts >= LOGIN_MAX_ATTEMPTS

        if (prev) {
          await tx
            .update(authLoginAttempts)
            .set({
              failedAttempts,
              // 仍在锁定期 → 原样回写 DB 早先写下的到期时刻（值本身来自 DB 时钟，不引入偏移）；
              // 否则按 shouldLock 让 DB 时钟加锁或清零。
              lockedUntil: prev.locked
                ? prev.lockedUntil
                : shouldLock
                  ? sql`now() + make_interval(secs => ${LOGIN_LOCK_SECONDS}::int)`
                  : null,
              lastFailureAt: new Date(),
            })
            .where(eq(authLoginAttempts.principal, principal))
        } else {
          await tx.execute(sql`
            INSERT INTO auth_login_attempts (principal, failed_attempts, locked_until, last_failure_at)
            VALUES (
              ${principal},
              ${failedAttempts},
              CASE WHEN ${shouldLock} THEN now() + make_interval(secs => ${LOGIN_LOCK_SECONDS}::int) ELSE NULL END,
              now()
            )
          `)
        }

        return { locked: shouldLock || Boolean(prev?.locked) }
      })
    },

    /** 口令校验通过即删行：表只存"失败态"，因此不需要任何清理任务。 */
    async clear(principal: string): Promise<void> {
      await db.delete(authLoginAttempts).where(eq(authLoginAttempts.principal, principal))
    },
  }
}

export type LoginAttemptStore = ReturnType<typeof createLoginAttemptStore>
