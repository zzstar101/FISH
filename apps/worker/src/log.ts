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

/**
 * 错误一律只留 message：`EmbeddingProviderError` 的 message 不含请求文本与上游响应体
 * （见 `jobs/embedding/providers/live.ts`），队列的 `lastError` 也是同一口径。
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 把 `Bun.nanoseconds()` 的读数换算成日志里的整数毫秒。 */
export function elapsedMs(startedAtNanos: number): number {
  return Math.round((Bun.nanoseconds() - startedAtNanos) / 1e6)
}
