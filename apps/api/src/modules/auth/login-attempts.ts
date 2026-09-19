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
 * 时间判定一律用 **DB 时钟**（`now()`，事务级常量），不用应用时钟：#125 的同一论证，
 * 若由应用时钟写、由 DB 时钟读，偏移会直接改变实际锁定时长——极端情况下
 * "锁 10 分钟"会退化成无限锁定。
 *
 * 并发：计数算术全部留在 SQL 语句里（见 `recordFailure` 的注释），不在 TS 里
 * "先读后写"。那样 5 个并行失败请求可以把"最多 5 次"放大成任意多次。
 */
export const LOGIN_MAX_ATTEMPTS = 5
export const LOGIN_LOCK_SECONDS = 10 * 60
export const LOGIN_WINDOW_SECONDS = 10 * 60

/** 与 profile / admin / transactions 的 store 相同：`db.execute` 的返回形状是 `{ rows }`。 */
function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}

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
      return rows[0]?.locked === true
    },

    /**
     * 记一次失败，返回本次之后是否处于锁定期。
     *
     * 为什么是"三步同事务"而不是"SELECT … FOR UPDATE 再判断"：**行不存在时 FOR UPDATE
     * 什么都锁不住**（Postgres 在 READ COMMITTED 下没有 gap lock），首批并发会全部走
     * INSERT 分支，只有一个成功、其余撞 23505 直接 500，而被 argon2 真正校验过的次数
     * 反而远超阈值。改成"幂等建行 + 单条 UPDATE 算计数"，算术全部留在 SQL 里，
     * 并发 UPDATE 在行锁上串行，每次读到的都是最新已提交值——与 #70 的
     * `recordMeetupTokenFailure` 同一形状。
     *
     * `now()` 在 Postgres 里是**事务级**常量，所以第 2、3 步看到的是同一个时钟；
     * 又因为窗口长度与锁定时长相等，"锁到期"与"出窗"落在同一瞬间且互斥，
     * 不会出现解锁后立刻被旧计数重新锁死的情况。
     */
    async recordFailure(principal: string): Promise<{ locked: boolean }> {
      return db.transaction(async (tx) => {
        await tx.execute(sql`
          INSERT INTO auth_login_attempts (principal, failed_attempts, locked_until, last_failure_at)
          VALUES (${principal}, 0, NULL, now())
          ON CONFLICT (principal) DO NOTHING
        `)

        // 锁定期内不推进计数（否则持续错误会把 10 分钟一路拖长）；出窗即新一代从 1 重算。
        const updated = rowsOf(
          await tx.execute(sql`
            UPDATE auth_login_attempts SET
              failed_attempts = CASE
                WHEN locked_until > now() THEN failed_attempts
                WHEN last_failure_at > now() - make_interval(secs => ${LOGIN_WINDOW_SECONDS}::int)
                  THEN failed_attempts + 1
                ELSE 1
              END,
              last_failure_at = now()
            WHERE principal = ${principal}
            RETURNING failed_attempts
          `),
        )
        const attempts = Number(updated[0]?.failed_attempts ?? 0)

        // 只在"刚好到达阈值且当前未锁"那一刻加锁；已锁定的行原样保留到期时刻。
        await tx.execute(sql`
          UPDATE auth_login_attempts SET locked_until = now() + make_interval(secs => ${LOGIN_LOCK_SECONDS}::int)
          WHERE principal = ${principal}
            AND failed_attempts = ${LOGIN_MAX_ATTEMPTS}
            AND (locked_until IS NULL OR locked_until <= now())
        `)

        // 锁定期内计数被冻结在阈值，所以 attempts 到阈 ⟺ 处于锁定期。
        return { locked: attempts >= LOGIN_MAX_ATTEMPTS }
      })
    },

    /** 口令校验通过 / 注册成功即删行：表只存"失败态"。 */
    async clear(principal: string): Promise<void> {
      await db.delete(authLoginAttempts).where(eq(authLoginAttempts.principal, principal))
    },
  }
}

export type LoginAttemptStore = ReturnType<typeof createLoginAttemptStore>
