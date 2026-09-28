import type {
  RecommendationEventType,
  RecommendationSource,
} from '@fish/contracts/recommendation/schema'
import type { Db } from '@fish/db/client'
import { jsonParam } from '@fish/db/json'
import { listings } from '@fish/db/schema/listings'
import { recommendationEvents } from '@fish/db/schema/recommendation-events'
import { recommendationRequests } from '@fish/db/schema/recommendation-requests'
import { and, eq, inArray } from 'drizzle-orm'

/** 一次推荐请求的上下文行。`id` 就是响应里的 `requestId`。 */
export interface RecommendationRequestRow {
  id: string
  userId: string | null
  anonymousSessionId: string | null
  strategyVersion: string
}

/** 一条待写入的行为事件（已解码成内部 id）。 */
export interface RecommendationEventRecord {
  eventId: string
  userId: string | null
  anonymousSessionId: string | null
  requestId: string | null
  listingId: string
  eventType: RecommendationEventType
  position: number | null
  source: RecommendationSource | null
  metadata: Record<string, unknown>
  occurredAt: Date
}

export interface RecommendationStore {
  createRequest(input: {
    userId: string | null
    anonymousSessionId: string
    strategyVersion: string
  }): Promise<RecommendationRequestRow>

  /** 批量取请求上下文（一次 `IN` 查询；归属校验只需要这几列）。 */
  findRequests(ids: string[]): Promise<RecommendationRequestRow[]>

  /** 事件必须绑定真实商品：先批量查存在的 id，再决定接受还是拒收。 */
  findExistingListingIds(ids: string[]): Promise<string[]>

  /**
   * 追加事件。返回**新落库**条数：撞 `event_id` 的行走 `ON CONFLICT DO NOTHING` 被吞掉，
   * 所以调用方算 duplicates 时要用"尝试写入数 − 返回数"。
   */
  insertEvents(records: RecommendationEventRecord[]): Promise<number>

  /**
   * 某商品是否已经记过某类事件。
   *
   * 只服务于 `PURCHASE` 这类「商品级唯一事实」：确认成交端点是幂等的（已 COMPLETED 的交易再
   * 确认仍返回成功），而 `recordDomainEvent` 每次都新生成 `eventId`，`event_id` 唯一索引对
   * 这种重复永远不生效 —— 卖家重复点确认或 HTTP 重放就能把最强的正样本无界放大。
   */
  hasListingEvent(listingId: string, eventType: RecommendationEventType): Promise<boolean>
}

export function createSqlRecommendationStore(db: Db): RecommendationStore {
  return {
    async createRequest(input) {
      const [row] = await db
        .insert(recommendationRequests)
        .values({
          userId: input.userId,
          anonymousSessionId: input.anonymousSessionId,
          strategyVersion: input.strategyVersion,
        })
        .returning({
          id: recommendationRequests.id,
          userId: recommendationRequests.userId,
          anonymousSessionId: recommendationRequests.anonymousSessionId,
          strategyVersion: recommendationRequests.strategyVersion,
        })
      if (!row) throw new Error('recommendation_requests 写入未返回行')
      return row
    },

    async findRequests(ids) {
      if (ids.length === 0) return []
      return db
        .select({
          id: recommendationRequests.id,
          userId: recommendationRequests.userId,
          anonymousSessionId: recommendationRequests.anonymousSessionId,
          strategyVersion: recommendationRequests.strategyVersion,
        })
        .from(recommendationRequests)
        .where(inArray(recommendationRequests.id, ids))
    },

    async findExistingListingIds(ids) {
      if (ids.length === 0) return []
      const rows = await db
        .select({ id: listings.id })
        .from(listings)
        .where(inArray(listings.id, ids))
      return rows.map((row) => row.id)
    },

    async insertEvents(records) {
      if (records.length === 0) return 0
      const inserted = await db
        .insert(recommendationEvents)
        .values(
          records.map((record) => ({
            eventId: record.eventId,
            userId: record.userId,
            anonymousSessionId: record.anonymousSessionId,
            requestId: record.requestId,
            listingId: record.listingId,
            eventType: record.eventType,
            position: record.position,
            source: record.source,
            // jsonb 必须过 `jsonParam`：裸对象在 drizzle 0.45 + bun-sql 下会被 stringify 两次，
            // 落库变成 JSON 字符串（`payload->>'x'` 恒为 NULL，见 packages/db/src/json.ts）。
            metadata: jsonParam(record.metadata),
            occurredAt: record.occurredAt,
          })),
        )
        // 不指定 target：表上有三条唯一索引（event_id、曝光类 (request_id,listing_id,event_type)、
        // 商品级 PURCHASE），冲突任何一个都该当"重复上报"静默吞掉并计入 duplicates。
        // PostgreSQL 的 ON CONFLICT 一次只能推断一个仲裁者，所以这里必须留空。
        .onConflictDoNothing()
        .returning({ id: recommendationEvents.id })
      return inserted.length
    },

    async hasListingEvent(listingId, eventType) {
      const [row] = await db
        .select({ id: recommendationEvents.id })
        .from(recommendationEvents)
        .where(
          and(
            eq(recommendationEvents.listingId, listingId),
            eq(recommendationEvents.eventType, eventType),
          ),
        )
        .limit(1)
      return row !== undefined
    },
  }
}
