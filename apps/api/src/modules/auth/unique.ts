/**
 * PG 唯一约束冲突的判定（register / bindPhone / wechat 首登共用）。
 *
 * 两个坑：Bun 的 `PostgresError` 把 SQLSTATE 放在 `errno` 上（`code` 恒为
 * `'ERR_POSTGRES_SERVER_ERROR'`）；而 Drizzle 会把它包一层（`{ query, params, cause }`），
 * 所以要顺着 `cause` 链找。
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if ('errno' in current && current.errno === '23505') return true
    current = current.cause
  }
  return false
}
