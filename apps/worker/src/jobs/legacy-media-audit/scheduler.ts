import type { Db } from '@fish/db/client'
import { enqueueLegacyMediaAuditBatch } from './enqueue'

/**
 * 周期性把 inventory 中到点的对象投成补审 job。
 *
 * 只投递、不审核：单条 job 的上游耗时不会阻塞 worker 主循环，也不会让一轮大批量审核
 * 拖住 1s 的 job 轮询。关掉 `LEGACY_MEDIA_AUDIT_ENABLED=false` 后不再新增待办，
 * 已经入队/在跑的 job 仍会完成。
 */
export function createLegacyMediaAuditBatchRunner(input: {
  db: Db
  enabled: boolean
  batchSize: number
  maxAttempts: number
}): () => Promise<void> {
  return async () => {
    if (!input.enabled) return
    try {
      const result = await enqueueLegacyMediaAuditBatch(input.db, {
        limit: input.batchSize,
        maxAttempts: input.maxAttempts,
      })
      if (result.enqueued > 0) {
        console.log(`[worker] 存量图补审投递 ${result.enqueued}/${result.candidates.length} 条待办`)
      }
    } catch (error) {
      // 一轮投递失败只记日志，下一轮自然重试；不阻塞其它周期任务。
      const detail = error instanceof Error ? error.message : String(error)
      console.error(`[worker] 存量图补审投递失败：${detail}`)
    }
  }
}
