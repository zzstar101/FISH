/**
 * worker 的结构化观测出口（#322 M4）。
 *
 * 全仓没有 logger / metrics 基建，这里也不引依赖：**一条事件 = 一行 JSON**，正常事件写 stdout、
 * 失败事件写 stderr。机器可以 grep / 聚合（`bun run dev:worker | jq 'select(.event == ...)'`），
 * 人也能直接读。
 *
 * 硬约束（#322 验收）：事件里只允许出现计数、耗时、状态、模型名、实体 id 与哈希；
 * **绝不写完整用户文本（愿望/商品描述）或向量本身**。要指代一段私密文本时用内容指纹
 * （`contentHashOf()`，`packages/contracts/src/embedding/text.ts:79`）+ 文本长度，两者都不含原文。
 *
 * 事件名约定（加新事件时沿用）：
 * - `job.settled`（`index.ts`）：每个 job 一行，含 job 类型/状态/耗时/结果与本轮用的 model、ranking_version；
 * - `embed.request`（`providers/live.ts` 的回调）：每次上游请求的尝试次数、耗时、结果分类；
 * - `embed.entity`（`jobs/embedding/handlers.ts`）：每个实体的生成结果（`unchanged` 即内容指纹命中）。
 */
export type WorkerEvent = Record<string, unknown> & { event: string }

/** 一条正常事件（stdout）。 */
export function logEvent(event: WorkerEvent): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }))
}

/** 一条失败事件（stderr）：与正常事件同形状，只是多了 `level`，便于按流分开消费。 */
export function logErrorEvent(event: WorkerEvent): void {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', ...event }))
}

const SQLSTATE = /^[0-9A-Z]{5}$/u

/**
 * 真实 DB 错误的公开特征（不依赖跨包/重复安装时的 `instanceof` 类身份）：
 * Drizzle 包装带 `query` + `params`；Bun 驱动错误带字符串 `errno`（SQLSTATE）与 `severity`；
 * 连接类失败带 `code = 'ERR_POSTGRES_*'`；`pg` 风格的驱动错误把 5 位 SQLSTATE 放在 `code`。
 *
 * **必须排除 Node 系统错误**：它们也可能有 5 位大写 `code`（`EPERM` / `EROFS` / `ELOOP`…），
 * 但一定带数字 `errno` / `syscall` / `path`，据此区分，而不是靠"5 位大写 code"本身
 * （`ENOENT`、`EACCES` 是 6 位，本来就落不进 SQLSTATE 形状）。
 */
function isDatabaseError(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  if ('query' in candidate && 'params' in candidate) return true
  if ('severity' in candidate) return true
  if (typeof candidate.errno === 'string') return true
  if (typeof candidate.code === 'string' && candidate.code.startsWith('ERR_POSTGRES')) return true
  if ('syscall' in candidate || 'path' in candidate || typeof candidate.errno === 'number')
    return false
  return typeof candidate.code === 'string' && SQLSTATE.test(candidate.code)
}

/** SQLSTATE 只从 DB 错误对象上取（Bun 放 `errno`，部分包装放 `code`）；取不到就不猜。 */
function sqlStateOf(value: unknown): string | null {
  if (!isDatabaseError(value)) return null
  for (const key of ['errno', 'code'] as const) {
    const candidate = value[key]
    if (typeof candidate === 'string' && SQLSTATE.test(candidate)) return candidate
  }
  return null
}

/**
 * Provider 的 message 已脱敏；DB 错误可能把 SQL / 参数 / DETAIL（含用户文本）拼进 message，
 * 所以这里**默认拒绝**：只要对象带 DB 错误特征就绝不回传 message，只留类别与安全 SQLSTATE。
 */
export function errorMessage(error: unknown): string {
  const cause =
    error instanceof Error && 'query' in error && 'params' in error ? error.cause : error
  const sqlState = sqlStateOf(cause) ?? sqlStateOf(error)
  if (sqlState !== null) return `database query failed (SQLSTATE ${sqlState})`
  if (isDatabaseError(cause) || isDatabaseError(error)) return 'database query failed'
  return error instanceof Error ? error.message : String(error)
}

/** 把 `Bun.nanoseconds()` 的读数换算成日志里的整数毫秒。 */
export function elapsedMs(startedAtNanos: number): number {
  return Math.round((Bun.nanoseconds() - startedAtNanos) / 1e6)
}
