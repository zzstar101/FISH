/**
 * 推荐上下文与埋点的保留期清理（#323 R6 §7，D9）。
 *
 * R1 的设计文档（`docs/design/issue-323-r1-event-tracking.md:135`）明确写了"R1 不做自动删除，
 * 保留期归 R6"——这就是那个 R6 的落点。两把时间尺：
 * - **上下文**（`recommendation_requests` + `recommendation_request_items`）留 90 天：它记的是
 *   "这个匿名会话某次看到了哪一页的哪几件"，越久越没有解释力，留着只是隐私负债；
 * - **事件**（`recommendation_events`）留 180 天：离线评估、漏斗与 guardrail 都靠它，窗口最长 30 天，
 *   180 天是"够复盘两个季度"与"不留永久行为档案"的折中。
 *
 * 顺序（§7.2）：**快照行 → 请求行 → 事件行**。快照表对 `request_id` 有 `ON DELETE CASCADE`，
 * 先删快照是为了把单次级联规模压在 `batch × ≤200` 行，而不是让一条 `DELETE` 级联出十万行；
 * 反过来（先删请求）就再也无法按批控制规模了。
 *
 * 与文档 §7.2 第 2 步的唯一差异（实现期修正，已记入文档）：**请求行按自己的截止时间选批**，
 * 而不是复用第 1 步取到的 request_id 集合。原因：降级 Feed（`rec-v1-none` 走游标直通）与
 * "快照写入失败"的请求**没有快照行**，复用第 1 步的 id 集合会让这些请求行永远删不掉——
 * 保留期承诺直接失效。按截止时间各选各的批，两个循环各自收敛，级联规模仍然有界。
 *
 * 幂等：删一半崩了下一轮重来即可（每批都是独立事务）；失败只往上抛，由调用方记日志、下轮重试。
 */
import {
  RECOMMENDATION_CLEANUP_BATCH_SIZE,
  RECOMMENDATION_CONTEXT_RETENTION_DAYS,
  RECOMMENDATION_EVENT_RETENTION_DAYS,
} from '@fish/contracts/recommendation/observability'
import type { Db } from '@fish/db/client'
import { sql } from 'drizzle-orm'

const DAY_MS = 24 * 60 * 60 * 1000

/** 批间让路：给别的连接留出机会，也避免一个长循环把连接占满（§7.2）。 */
const BATCH_PAUSE_MS = 50

export type RecommendationCleanupResult = {
  deletedRequestItems: number
  deletedRequests: number
  deletedEvents: number
  batches: number
}

/**
 * `DELETE … RETURNING id` 的返回形状在 bun-sql 与 `{ rows }` 两种包装下都出现过（见
 * `apps/api/src/modules/admin/store.ts` 的 `rowsOf`），这里同样两种都接。
 */
function returnedRowCount(result: unknown): number {
  if (Array.isArray(result)) return result.length
  const rows = (result as { rows?: unknown[] } | null | undefined)?.rows
  return Array.isArray(rows) ? rows.length : 0
}

function scalarCount(result: unknown): number {
  const rows = Array.isArray(result)
    ? result
    : ((result as { rows?: unknown[] } | null | undefined)?.rows ?? [])
  const first = rows[0] as { count?: unknown } | undefined
  return Number(first?.count ?? 0)
}

export async function cleanupExpiredRecommendationData(input: {
  db: Db
  now: Date
  batchSize?: number
  dryRun?: boolean
}): Promise<RecommendationCleanupResult> {
  const batch = input.batchSize ?? RECOMMENDATION_CLEANUP_BATCH_SIZE
  if (!Number.isInteger(batch) || batch <= 0) {
    throw new Error('清理批大小必须是正整数')
  }
  const contextCutoff = new Date(
    input.now.getTime() - RECOMMENDATION_CONTEXT_RETENTION_DAYS * DAY_MS,
  )
  const eventCutoff = new Date(input.now.getTime() - RECOMMENDATION_EVENT_RETENTION_DAYS * DAY_MS)

  const countRequestItems = async () =>
    scalarCount(
      await input.db.execute(sql`
        SELECT count(*)::int AS count
        FROM recommendation_request_items i
        JOIN recommendation_requests r ON r.id = i.request_id
        WHERE r.requested_at < ${contextCutoff}
      `),
    )
  const countRequests = async () =>
    scalarCount(
      await input.db.execute(sql`
        SELECT count(*)::int AS count
        FROM recommendation_requests
        WHERE requested_at < ${contextCutoff}
      `),
    )
  const countEvents = async () =>
    scalarCount(
      await input.db.execute(sql`
        SELECT count(*)::int AS count
        FROM recommendation_events
        WHERE occurred_at < ${eventCutoff}
      `),
    )

  if (input.dryRun) {
    // 只统计不写：三个计数各自独立，`Promise.all` 是因为它们互不依赖（同一连接上的三条只读查询）。
    const [items, requests, events] = await Promise.all([
      countRequestItems(),
      countRequests(),
      countEvents(),
    ])
    return {
      deletedRequestItems: items,
      deletedRequests: requests,
      deletedEvents: events,
      batches: 0,
    }
  }

  const deleteRequestItems = async () =>
    returnedRowCount(
      await input.db.execute(sql`
        DELETE FROM recommendation_request_items
        WHERE request_id IN (
          SELECT id FROM recommendation_requests
          WHERE requested_at < ${contextCutoff}
          ORDER BY requested_at
          LIMIT ${batch}
        )
        RETURNING id
      `),
    )
  const deleteRequests = async () =>
    returnedRowCount(
      await input.db.execute(sql`
        DELETE FROM recommendation_requests
        WHERE id IN (
          SELECT id FROM recommendation_requests
          WHERE requested_at < ${contextCutoff}
          ORDER BY requested_at
          LIMIT ${batch}
        )
        RETURNING id
      `),
    )
  const deleteEvents = async () =>
    returnedRowCount(
      await input.db.execute(sql`
        DELETE FROM recommendation_events
        WHERE id IN (
          SELECT id FROM recommendation_events
          WHERE occurred_at < ${eventCutoff}
          ORDER BY occurred_at
          LIMIT ${batch}
        )
        RETURNING id
      `),
    )

  let deletedRequestItems = 0
  let deletedRequests = 0
  let deletedEvents = 0
  let batches = 0

  // 三类各自循环到空：某一类先清完不代表别的也清完了，所以用"本轮三类合计是否为 0"当终止条件。
  for (;;) {
    const items = await deleteRequestItems()
    const requests = await deleteRequests()
    const events = await deleteEvents()
    if (items + requests + events === 0) break

    deletedRequestItems += items
    deletedRequests += requests
    deletedEvents += events
    batches += 1
    console.log(
      `[recommendation-cleanup] 第 ${batches} 批：快照行 ${items} / 请求行 ${requests} / 事件行 ${events}`,
    )
    await Bun.sleep(BATCH_PAUSE_MS)
  }

  return { deletedRequestItems, deletedRequests, deletedEvents, batches }
}
