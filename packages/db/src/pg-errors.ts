/**
 * PG SQLSTATE 谓词（跨模块共用的最小集合）。
 *
 * 为什么要有这一层：Bun 的 `PostgresError` 把 SQLSTATE 放在 `errno` 上（`code` 恒为
 * `'ERR_POSTGRES_SERVER_ERROR'`），而 Drizzle 会再包一层 `{ query, params, cause }`，
 * 所以要顺着 `cause` 链找。每个调用方各写一遍这个走链逻辑必然漂移。
 *
 * 放在 `packages/db` 而不是某个 api 模块里：这是对**数据库错误码**的判定，与谁在写无关。
 * （`apps/api/src/modules/auth/unique.ts` 里那份 23505 的判定早于本文件，本文件不搬它 ——
 * 那是无关重构。）
 */

/** 沿 `cause` 链找 SQLSTATE。链深上限 5 与 `auth/unique.ts` 同一取舍：防环、够用。 */
function hasSqlState(error: unknown, sqlState: string): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if ('errno' in current && current.errno === sqlState) return true
    current = current.cause
  }
  return false
}

/**
 * 外键约束冲突（SQLSTATE 23503）。
 *
 * 用途：**并发下父行消失**。典型的读-写不原子路径（先 `SELECT` 判存在、再 `INSERT`）
 * 在两步之间被另一事务删掉了父行时，`INSERT` 会撞外键。这类冲突的语义通常不是 500
 * 而是 404（「目标不存在」），调用方据此把结论翻成自己域的错误码。
 *
 * 与 `auth/unique.ts` 的 23505 分开命名：两者都是约束冲突，但**语义完全不同**
 * （唯一冲突是幂等/重试，外键冲突是目标消失），混用一个谓词必然有一方判错。
 */
export function isForeignKeyViolation(error: unknown): boolean {
  return hasSqlState(error, '23503')
}
