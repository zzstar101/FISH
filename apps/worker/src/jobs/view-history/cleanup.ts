/**
 * 浏览足迹的到期清理（#415 M1）。
 *
 * 端上对用户的承诺是「浏览记录只保留最近 30 天」（读接口也用同一个窗口过滤，
 * 见 `VIEW_HISTORY_RETENTION_MS`），所以窗口外的行不只是"读不到"，而是**物理删除**：
 * 用户资产不该在承诺的保留期之后继续留在库里。
 *
 * 与 `recommendation_events` 的保留期（180 天，R6 的删除任务）**完全无关、互不依赖**：
 * 那条任务删训练数据，这里删用户可见的足迹表（清空接口也只删这张表）。
 *
 * 一次只取一批：清理是后台杂务，不该在一次运行里扫全表。先取 id 再按 id 删，
 * 删除带 `returning` 拿真实行数（并发下"取到时还在、删时没了"由 WHERE 兜住）。
 */
import { VIEW_HISTORY_RETENTION_MS } from '@fish/contracts/view-history/schema'
import type { Db } from '@fish/db/client'
import { listingViewHistory } from '@fish/db/schema/view-history'
import { asc, inArray, lt } from 'drizzle-orm'

/** 一轮最多删多少行：与 worker 的维护间隔配合，够用且不会长时间占住连接。 */
export const VIEW_HISTORY_CLEANUP_BATCH_SIZE = 500

export type ViewHistoryCleanupResult = { scanned: number; deleted: number }

export async function cleanupExpiredViewHistory(input: {
  db: Db
  now: Date
  limit?: number
}): Promise<ViewHistoryCleanupResult> {
  const cutoff = new Date(input.now.getTime() - VIEW_HISTORY_RETENTION_MS)

  const rows = await input.db
    .select({ id: listingViewHistory.id })
    .from(listingViewHistory)
    .where(lt(listingViewHistory.lastViewedAt, cutoff))
    .orderBy(asc(listingViewHistory.lastViewedAt))
    .limit(input.limit ?? VIEW_HISTORY_CLEANUP_BATCH_SIZE)

  if (rows.length === 0) return { scanned: 0, deleted: 0 }

  const deleted = await input.db
    .delete(listingViewHistory)
    .where(
      inArray(
        listingViewHistory.id,
        rows.map((row) => row.id),
      ),
    )
    .returning({ id: listingViewHistory.id })

  return { scanned: rows.length, deleted: deleted.length }
}
