/**
 * 事件 → 浏览足迹的落库（#415 M1 的写入路径）。
 *
 * ## 触发复用埋点，不新增端上调用
 *
 * 两端详情页本来就发 `DETAIL_VIEW`（web-pc `use-detail-tracking.ts`、miniapp
 * `use-listing-detail-tracking.ts`），这条链路已有客户端离线队列与 `event_id` 幂等重试。
 * 浏览记录因此**不需要端上再发一次请求**：服务端在 `POST /recommendation/events` 的事件
 * 落库事务里顺带 upsert 本表（`recommendation/store.ts` 的 `insertEvents` 调用这里）。
 * 代价是埋点丢则足迹同步丢 —— 接受（历史是弱一致的用户资产，不是账）。
 *
 * ## 只认 `DETAIL_VIEW`，且只认登录用户
 *
 * - `LONG_VIEW` / `IMAGE_VIEW` 必然发生在一次 `DETAIL_VIEW` 之后（同一页面实例），
 *   重复记只会让时间被同一次浏览的后续事件反复顶新；`FAVORITE` / `COMMENT` 等更不是浏览。
 * - `user_id` 为空（匿名会话）不写：浏览记录是账号的资产，把匿名会话的行为写进去，
 *   会在用户登录后凭空多出一段"他没登录时看的"历史（Owner 待定项 3 的推荐默认：不回填）。
 *   注意事件里的 `user_id` 可能是**请求行**的真值（补发时按请求归属），这里直接用事件上
 *   已解析好的那一列，不再自己判身份。
 *
 * ## `GREATEST` 而不是覆盖写
 *
 * 客户端离线队列补发时，旧事件可能晚于新事件到达。若直接覆盖 `last_viewed_at`，
 * 用户刚看过的商品会被一条几分钟前补发的旧事件顶到列表后面（时间倒退）。`GREATEST`
 * 让写入单调不减。同一批里同一件商品出现多次也先在这里归并（取最新）——
 * PostgreSQL 的 `ON CONFLICT DO UPDATE` 不允许同一条语句影响同一行两次
 * （`cannot affect row a second time`），归并不是优化而是**必需**。
 */
import type { Db } from '@fish/db/client'
import { listingViewHistory } from '@fish/db/schema/view-history'
import { sql } from 'drizzle-orm'

/** 事件侧的最小输入形状（结构匹配 `RecommendationEventRecord`，只取需要的四列）。 */
export interface ViewEventSource {
  userId: string | null
  listingId: string
  eventType: string
  occurredAt: Date
}

/** 待写入足迹的一行（已去重、已定序）。 */
export interface ViewHistoryRecord {
  userId: string
  listingId: string
  viewedAt: Date
}

/** 只有登录用户的 `DETAIL_VIEW` 进足迹；同 `(user, listing)` 取最新一条。 */
export function viewRecordsFromEvents(events: readonly ViewEventSource[]): ViewHistoryRecord[] {
  const latest = new Map<string, ViewHistoryRecord>()
  for (const event of events) {
    if (event.eventType !== 'DETAIL_VIEW') continue
    if (event.userId === null) continue
    const key = `${event.userId}:${event.listingId}`
    const existing = latest.get(key)
    if (existing === undefined || event.occurredAt.getTime() > existing.viewedAt.getTime()) {
      latest.set(key, {
        userId: event.userId,
        listingId: event.listingId,
        viewedAt: event.occurredAt,
      })
    }
  }
  return [...latest.values()]
}

/**
 * 写足迹。executor 收窄成 `Pick<Db, 'insert'>`，因此既能在 `db` 上直接用，
 * 也能在事件落库的 `db.transaction(tx => …)` 里传 `tx` —— **与事件同一事务**，
 * 不允许出现"事件写进去了、足迹没写"的中间态。
 */
export async function recordViewHistoryWith(
  executor: Pick<Db, 'insert'>,
  records: readonly ViewHistoryRecord[],
): Promise<void> {
  if (records.length === 0) return
  await executor
    .insert(listingViewHistory)
    .values(records.map((record) => ({ ...record, lastViewedAt: record.viewedAt })))
    .onConflictDoUpdate({
      target: [listingViewHistory.userId, listingViewHistory.listingId],
      set: {
        lastViewedAt: sql`greatest(${listingViewHistory.lastViewedAt}, excluded.last_viewed_at)`,
      },
    })
}
