/**
 * 周期性视觉维护（回填 + 到期查询图清理）的一轮执行。
 *
 * 抽成独立模块是为了可测：`apps/worker/src/index.ts` 顶层就建队列、跑主循环，测试无法 import
 * 它，于是"维护失败往 stderr 写什么"此前没有任何回归覆盖。
 *
 * 失败上报**必须**只写脱敏摘要。drizzle 的错误 `message` 里带 SQL 文本与绑定参数值
 * （`Failed query: select $1::int` + `params: <用户文本>`），直接写 stderr 就是泄漏；走
 * `./log` 的 `errorMessage()` 只回 `database query failed (SQLSTATE XXXXX)`，仍然可诊断。
 * 约束与 `jobs/queue.ts` 落 `job.last_error` 前脱敏、`log.ts` 的 `embed.*` 事件同源（#322 M4）。
 */
import { errorMessage } from '../../log'

export type VisualMaintenanceDeps = {
  /** 回填一批（封面新增/替换后的补齐）。 */
  backfill: () => Promise<{ enqueued: number }>
  /** 清理到期查询图。 */
  cleanup: (now: Date) => Promise<{ deleted: number }>
  /** 正常进度行（默认 stdout）。 */
  report?: (line: string) => void
  /** 失败摘要行（默认 stderr）。 */
  reportFailure?: (line: string) => void
}

export function createVisualMaintenance(deps: VisualMaintenanceDeps): (now: Date) => Promise<void> {
  const report = deps.report ?? ((line: string) => console.log(line))
  const reportFailure = deps.reportFailure ?? ((line: string) => console.error(line))

  return async function runVisualMaintenance(now: Date): Promise<void> {
    try {
      const backfill = await deps.backfill()
      if (backfill.enqueued > 0) report(`[worker] 视觉回填投递 ${backfill.enqueued} 条`)
      const cleanup = await deps.cleanup(now)
      if (cleanup.deleted > 0) report(`[worker] 清理到期查询图 ${cleanup.deleted} 个`)
    } catch (error) {
      // 维护失败不能把 worker 主循环带走：回填游标留在内存里、清理按 expires_at 升序重来，
      // 下一轮会自然重新捡起同一批。
      reportFailure(`[worker] 视觉维护失败：${errorMessage(error)}`)
    }
  }
}
