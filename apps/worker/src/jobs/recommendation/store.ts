// ---------------------------------------------------------------------------
// #323 R6 离线评估的取数层（PR-1）。
//
// 这里只做一件事：把「请求 + 快照 + 事件 + 商品元数据」按 §4 的口径从库里读出来，
// 交给 `eval.ts` 的纯函数算指标。取数与算指标分开，是为了让口径可单测（纯函数）
// 且让 SQL 可单独跑（集成测试）。
//
// 两条纪律（设计文档 §4.2 / §4.3）：
//   1. 请求侧按 `requested_at` 切窗，事件侧按 `occurred_at` 切窗 —— 两个时间轴不混用；
//   2. 事件归因**不用事件自带的 `request_id`**，而是按「同身份 + 快照含该商品 + 落在 W 内」
//      重算，并取最早的那次请求（同一商品可以在多次快照里出现）。
// ---------------------------------------------------------------------------

import type { RecommendationEventType } from '@fish/contracts/recommendation/schema'
import { RecommendationEventTypeSchema } from '@fish/contracts/recommendation/schema'
import type { Db } from '@fish/db/client'
import { sql } from 'drizzle-orm'
import type { RankEvalDataset, RankEvalEvent, RankEvalListing, RankEvalRequest } from './eval'

export type RankEvalLoadCriteria = {
  /** 请求轴左闭、事件轴左闭右开。 */
  since: Date
  until: Date
  /** 归因窗 `W`（§4.3）。 */
  attributionWindowMs: number
  /** 只回放最近 N 条请求（缺省不限）。大库上先抽样看口径时用。 */
  limitRequests?: number
}

export interface RankEvalStore {
  loadDataset(criteria: RankEvalLoadCriteria): Promise<RankEvalDataset>
}

/** `db.execute` 的返回形状是 `{ rows }`（与 `apps/api/src/modules/admin/store.ts` 同一套归一）。 */
function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}

/** bun-sql 对 timestamptz 一般直接给 `Date`；给字符串也接受，但给别的就是 bug，要炸出来。 */
function toDate(value: unknown, label: string): Date {
  if (value instanceof Date) return value
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  throw new Error(`离线评估取数：${label} 不是合法时间（实得 ${String(value)}）`)
}

function toText(value: unknown, label: string): string {
  if (typeof value === 'string') return value
  throw new Error(`离线评估取数：${label} 不是字符串（实得 ${String(value)}）`)
}

function toEventType(value: unknown): RecommendationEventType {
  const parsed = RecommendationEventTypeSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error(`离线评估取数：未知事件类型 ${String(value)}（契约与库不一致）`)
  }
  return parsed.data
}

/**
 * jsonb 列在裸 `db.execute` 下可能是对象，也可能是字符串（取决于驱动路径），两种都收。
 * 形状不符不在这里判：`eval.ts` 会把它记进 `skippedBreakdownRows`，比抛错更利于排查。
 */
function toJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/** 身份键：与 `packages/db/src/recall-store.ts` 的谓词同义（user 优先，否则匿名会话）。 */
const IDENTITY_SQL = (alias: string) => sql`CASE
  WHEN ${sql.raw(alias)}.user_id IS NOT NULL THEN 'user:' || ${sql.raw(alias)}.user_id::text
  ELSE 'anon:' || ${sql.raw(alias)}.anonymous_session_id::text
END`

export function createRankEvalStore(db: Db): RankEvalStore {
  return {
    async loadDataset({ since, until, attributionWindowMs, limitRequests }) {
      const limit = limitRequests === undefined || limitRequests <= 0 ? null : limitRequests
      // 归因候选请求要往前多取一个归因窗：窗口起点的曝光，其请求可能落在窗口之前。
      const candidateSince = new Date(since.getTime() - attributionWindowMs)

      const requestResult = await db.execute(sql`
        WITH windowed AS (
          SELECT r.id, r.requested_at, r.strategy_version, ${IDENTITY_SQL('r')} AS identity
          FROM recommendation_requests r
          WHERE r.requested_at >= ${since} AND r.requested_at < ${until}
          ORDER BY r.requested_at DESC, r.id DESC
          LIMIT ${limit}
        )
        SELECT w.id::text                            AS request_id,
               w.requested_at,
               w.strategy_version,
               w.identity,
               i.position,
               i.listing_id::text                    AS listing_id,
               i.primary_source,
               i.rank_breakdown
        FROM windowed w
        LEFT JOIN recommendation_request_items i ON i.request_id = w.id
        ORDER BY w.requested_at ASC, w.id ASC, i.position ASC
      `)

      const eventResult = await db.execute(sql`
        WITH candidates AS (
          SELECT ${IDENTITY_SQL('r')} AS identity, r.id AS request_id, r.requested_at, i.listing_id
          FROM recommendation_requests r
          JOIN recommendation_request_items i ON i.request_id = r.id
          WHERE r.requested_at >= ${candidateSince} AND r.requested_at < ${until}
        )
        SELECT e.event_type::text        AS event_type,
               e.listing_id::text        AS listing_id,
               e.occurred_at,
               a.request_id::text        AS attributed_request_id
        FROM recommendation_events e
        LEFT JOIN LATERAL (
          SELECT c.request_id
          FROM candidates c
          WHERE c.listing_id = e.listing_id
            AND c.identity = ${IDENTITY_SQL('e')}
            AND c.requested_at <= e.occurred_at
            AND e.occurred_at <= c.requested_at + ${Math.round(attributionWindowMs)}::int * interval '1 millisecond'
          ORDER BY c.requested_at ASC, c.request_id ASC
          LIMIT 1
        ) a ON TRUE
        WHERE e.occurred_at >= ${since} AND e.occurred_at < ${until}
        ORDER BY e.occurred_at ASC, e.id ASC
      `)

      const listingResult = await db.execute(sql`
        WITH windowed AS (
          SELECT r.id
          FROM recommendation_requests r
          WHERE r.requested_at >= ${since} AND r.requested_at < ${until}
          ORDER BY r.requested_at DESC, r.id DESC
          LIMIT ${limit}
        )
        SELECT l.id::text          AS listing_id,
               l.seller_id::text   AS seller_id,
               l.category::text    AS category,
               l.status::text      AS status,
               l.created_at
        FROM listings l
        WHERE l.id IN (
          SELECT i.listing_id
          FROM recommendation_request_items i
          WHERE i.request_id IN (SELECT id FROM windowed)
          UNION
          SELECT e.listing_id
          FROM recommendation_events e
          WHERE e.occurred_at >= ${since} AND e.occurred_at < ${until}
        )
      `)

      // 可见性口径只有一份：与 `packages/db/src/recall-store.ts` 的 `visibleListingConditions` 同义。
      const visibleResult = await db.execute(sql`
        SELECT l.id::text          AS listing_id,
               l.seller_id::text   AS seller_id,
               l.category::text    AS category,
               l.status::text      AS status,
               l.created_at
        FROM listings l
        WHERE l.status = 'ACTIVE'
          AND l.moderation_status = 'APPROVED'
          AND l.governance_delisted_at IS NULL
          AND l.created_at < ${until}
      `)

      const requests: RankEvalRequest[] = []
      const requestById = new Map<string, RankEvalRequest>()
      for (const row of rowsOf(requestResult)) {
        const requestId = toText(row.request_id, 'request_id')
        let request = requestById.get(requestId)
        if (request === undefined) {
          request = {
            requestId,
            identity: toText(row.identity, 'identity'),
            strategyVersion: toText(row.strategy_version, 'strategy_version'),
            requestedAt: toDate(row.requested_at, 'requested_at'),
            items: [],
          }
          requestById.set(requestId, request)
          requests.push(request)
        }
        // LEFT JOIN：没有快照行的请求会来一行全 null，跳过它（`items` 保持空数组）。
        if (row.listing_id === null || row.position === null) continue
        request.items.push({
          listingId: toText(row.listing_id, 'listing_id'),
          position: Number(row.position),
          primarySource:
            row.primary_source === null ? null : toText(row.primary_source, 'primary_source'),
          rankBreakdown: toJson(row.rank_breakdown),
        })
      }

      const events: RankEvalEvent[] = rowsOf(eventResult).map((row) => ({
        listingId: toText(row.listing_id, 'listing_id'),
        eventType: toEventType(row.event_type),
        occurredAt: toDate(row.occurred_at, 'occurred_at'),
        attributedRequestId:
          row.attributed_request_id === null
            ? null
            : toText(row.attributed_request_id, 'request_id'),
      }))

      const toListing = (row: Record<string, unknown>): RankEvalListing => ({
        listingId: toText(row.listing_id, 'listing_id'),
        sellerId: toText(row.seller_id, 'seller_id'),
        category: toText(row.category, 'category'),
        createdAt: toDate(row.created_at, 'created_at'),
        status: toText(row.status, 'status'),
      })

      return {
        since,
        until,
        requests,
        events,
        listings: rowsOf(listingResult).map(toListing),
        visibleListings: rowsOf(visibleResult).map(toListing),
      }
    },
  }
}
