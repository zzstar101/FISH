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
 * ## 两处刻意的取舍
 *
 * - **先取 id 再按 id 删，但删除条件里再带一次窗口**：SELECT 与 DELETE 之间，某行的
 *   `last_viewed_at` 可能被并发的 DETAIL_VIEW upsert 刷新成"现在"（`GREATEST` 把它变回
 *   窗口内）。只按 id 删会把用户刚产生的浏览记录删掉；带上 `last_viewed_at < cutoff`
 *   后，这种行会被 WHERE 留下，下一轮也不会再被选中 —— 读到才删，语义上没有"删错"。
 * - **一轮内循环直到追平，但总行数有上限**：清理每小时才跑一次，若单次只删一批（500 行），
 *   稳态过期速率超过 500/小时就永远追不上。循环到"本批不足 limit"为止，并用
 *   `VIEW_HISTORY_CLEANUP_MAX_ROUNDS` 给单次运行封顶，避免长时间占住连接。
 */
import { VIEW_HISTORY_RETENTION_MS } from '@fish/contracts/view-history/schema'
import type { Db } from '@fish/db/client'
import { listingViewHistory } from '@fish/db/schema/view-history'
import { and, asc, inArray, lt } from 'drizzle-orm'

/** 一批最多查/删多少行：与 worker 的维护间隔配合，够用且不会长时间占住连接。 */
export const VIEW_HISTORY_CLEANUP_BATCH_SIZE = 500

/** 单次运行最多循环几轮（500 × 20 = 10000 行）：稳态追平用，封顶防长事务式占用。 */
export const VIEW_HISTORY_CLEANUP_MAX_ROUNDS = 20

export type ViewHistoryCleanupResult = { scanned: number; deleted: number }

export async function cleanupExpiredViewHistory(input: {
  db: Db
  now: Date
  limit?: number
  maxRounds?: number
}): Promise<ViewHistoryCleanupResult> {
  const cutoff = new Date(input.now.getTime() - VIEW_HISTORY_RETENTION_MS)
  const limit = input.limit ?? VIEW_HISTORY_CLEANUP_BATCH_SIZE
  const maxRounds = input.maxRounds ?? VIEW_HISTORY_CLEANUP_MAX_ROUNDS

  let scanned = 0
  let deleted = 0
  for (let round = 0; round < maxRounds; round += 1) {
    const rows = await input.db
      .select({ id: listingViewHistory.id })
      .from(listingViewHistory)
      .where(lt(listingViewHistory.lastViewedAt, cutoff))
      .orderBy(asc(listingViewHistory.lastViewedAt))
      .limit(limit)

    scanned += rows.length
    if (rows.length === 0) break
    // 删除条件带窗口：SELECT 之后被 upsert 刷新回窗口内的行会被留下（见文件头）。
    // 只剩被刷新行时本批 deleted 为 0，但 rows.length === limit 仍会再转一轮，
    // 下一轮重新 SELECT 就看不到它们了 —— 循环因此收敛。
    const removed = await input.db
      .delete(listingViewHistory)
      .where(
        and(
          inArray(
            listingViewHistory.id,
            rows.map((row) => row.id),
          ),
          lt(listingViewHistory.lastViewedAt, cutoff),
        ),
      )
      .returning({ id: listingViewHistory.id })
    deleted += removed.length

    if (rows.length < limit) break
  }

  return { scanned, deleted }
}
