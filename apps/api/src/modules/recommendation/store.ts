import type {
  RecommendationEventType,
  RecommendationSource,
} from '@fish/contracts/recommendation/schema'
import type { Db } from '@fish/db/client'
import { jsonParam } from '@fish/db/json'
import {
  findNegativeFeedbackEvents as findNegativeFeedbackEventsQuery,
  type NegativeFeedbackEvent,
} from '@fish/db/recall-store'
import { listings } from '@fish/db/schema/listings'
import { recommendationEvents } from '@fish/db/schema/recommendation-events'
import { recommendationRequestItems } from '@fish/db/schema/recommendation-request-items'
import { recommendationRequests } from '@fish/db/schema/recommendation-requests'
import type { InterestIdentity } from '@fish/db/user-interest-store'
import { and, asc, eq, inArray } from 'drizzle-orm'

/** 一次推荐请求的上下文行。`id` 就是响应里的 `requestId`。 */
export interface RecommendationRequestRow {
  id: string
  userId: string | null
  anonymousSessionId: string | null
  strategyVersion: string
}

/**
 * 快照里的一条有序结果（R4）。`position` 是**服务端认定的曝光序号真值**。
 *
 * 落库这一层不是为了"多存点数据"，而是为了让归因有唯一真值：客户端上报的 position/source 可以
 * 是错的（旧版本、乱序重试、恶意构造），只有服务端当时确实返回了什么、在第几位，才是真的。
 */
export interface RecommendationRequestItemRecord {
  requestId: string
  position: number
  listingId: string
  primarySource: RecommendationSource
  sources: RecommendationSource[]
  rankScore: number
  rankBreakdown: Record<string, unknown>
}

export interface RecommendationRequestItemRow {
  requestId: string
  position: number
  listingId: string
  primarySource: RecommendationSource
  sources: RecommendationSource[]
  rankScore: number
}

/** 归因真值：`(requestId, listingId)` → 服务端当时认定的 position/source。 */
export interface RecommendationItemAttribution {
  requestId: string
  listingId: string
  position: number
  primarySource: RecommendationSource
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
  /**
   * 写请求上下文行。`id` 由调用方给定（N2）：服务端要**先**拿到 `requestId` 才能把它当作
   * 探索打散种子与快照外键，而请求行要等排序成功、确定 strategyVersion 之后再写。
   */
  createRequest(input: {
    id: string
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

  /**
   * **一次事务**写完请求上下文与本次推荐的有序快照，返回请求行。
   *
   * 两者必须原子：`recommendation_request_items` 的契约是「快照行与请求行同生共死」。若请求行落库
   * 而快照失败，服务端就会发出一个**自己没有归因真值**的 ranked `requestId` —— 客户端照它上报的
   * 整页曝光在 R4 之后全部落进 `attribution_not_found` 被静默拒收（position/source 只信快照），
   * R6 的 `empty_ranked_feed_requests` 还会把这条孤儿行报成数据质量异常。
   *
   * 所以不再提供「先建请求行、再单独插快照」的端口：唯一的生产写法只有这一种，失败即整笔回滚，
   * 由调用方降级成 `rec-v1-none` 透传。
   *
   * `records` 允许为空：重排把候选全部过滤掉（例如全被负反馈隐藏）时，本次 ranked 请求确实没有
   * 任何卡片，这时只落请求行 —— R6 的 `empty_ranked_feed_requests` 正是用来观测这种"排序成功
   * 但一页为空"的。
   */
  createRequestWithItems(
    input: {
      id: string
      userId: string | null
      anonymousSessionId: string
      strategyVersion: string
    },
    records: readonly RecommendationRequestItemRecord[],
  ): Promise<RecommendationRequestRow>

  /** 按 position 升序取快照（翻页按 offset 切片）。 */
  findRequestItems(requestId: string): Promise<RecommendationRequestItemRow[]>

  /**
   * 批量取归因真值（一次 `IN` 查询，避免 ingest 里按事件逐条查）。
   *
   * `listingIds` 必须一起下推：真值只可能落在 `(requestId, listingId)` 命中的行上，两个条件都进
   * `WHERE`，键不可能落在输入之外。
   *
   * 索引口径（别把收益说过头）：只有 `requestId` 走 `_request_id_idx`；`listing_id` **不在任何
   * 索引键里**，商品条件是取回行之后的过滤 —— 索引扫描仍覆盖这 ≤50 个请求的整份快照
   * （上界 50×200）。被压下来的是**返回**行数（上界 50 请求 × 本批商品数），不是扫描宽度。
   * 真要让商品条件也走索引得补 `(request_id, listing_id)` 复合索引；当前规模不值得，故不加。
   */
  findRequestItemAttribution(input: {
    requestIds: string[]
    listingIds: string[]
  }): Promise<RecommendationItemAttribution[]>

  /**
   * 取负反馈事件（R4 的 `negativeFeedback` 特征输入）。
   *
   * 走 store 而不是让 service 直接拿 `db`：SQL 只住在这一层，service 只依赖端口 —— 与
   * `recall-store.ts` 里已经存在的同名查询共用一条身份谓词实现（复用而非重写）。
   */
  findNegativeFeedbackEvents(input: {
    identity: InterestIdentity
    since: Date
    eventTypes: readonly RecommendationEventType[]
  }): Promise<NegativeFeedbackEvent[]>
}

export function createSqlRecommendationStore(db: Db): RecommendationStore {
  return {
    async createRequest(input) {
      const [row] = await db
        .insert(recommendationRequests)
        .values({
          id: input.id,
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

    async createRequestWithItems(input, records) {
      // 请求行与快照行同生共死：`recommendation_request_items` 的外键就是按这个不变式建的。
      return db.transaction(async (tx) => {
        const [row] = await tx
          .insert(recommendationRequests)
          .values({
            id: input.id,
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
        if (records.length === 0) return row

        // 不用 `onConflictDoNothing`：`(request_id, position)` 冲突只可能来自重复写同一次请求，
        // 静默吞掉会让"快照没写对"变成一个看不见的错误。让它抛，整笔事务回滚 ——
        // 调用方据此降级，绝不会留下一条没有快照的 ranked 请求行。
        await tx.insert(recommendationRequestItems).values(
          records.map((record) => ({
            requestId: record.requestId,
            position: record.position,
            listingId: record.listingId,
            primarySource: record.primarySource,
            sources: record.sources,
            rankScore: record.rankScore,
            // 同 `metadata`：jsonb 必须过 `jsonParam`，否则落库是 JSON 字符串。
            rankBreakdown: jsonParam(record.rankBreakdown),
          })),
        )
        return row
      })
    },

    async findRequestItems(requestId) {
      return db
        .select({
          requestId: recommendationRequestItems.requestId,
          position: recommendationRequestItems.position,
          listingId: recommendationRequestItems.listingId,
          primarySource: recommendationRequestItems.primarySource,
          sources: recommendationRequestItems.sources,
          rankScore: recommendationRequestItems.rankScore,
        })
        .from(recommendationRequestItems)
        .where(eq(recommendationRequestItems.requestId, requestId))
        .orderBy(asc(recommendationRequestItems.position))
    },

    async findRequestItemAttribution(input) {
      // 防御性早返回：正常调用方不会传空（ingest 至少 1 条事件、recordDomainEvent 单元素），
      // 且 drizzle 对空数组也会生成 `false`（实测 0 行）—— 这里只是省一次空查询。
      if (input.requestIds.length === 0 || input.listingIds.length === 0) return []
      return db
        .select({
          requestId: recommendationRequestItems.requestId,
          listingId: recommendationRequestItems.listingId,
          position: recommendationRequestItems.position,
          primarySource: recommendationRequestItems.primarySource,
        })
        .from(recommendationRequestItems)
        .where(
          and(
            inArray(recommendationRequestItems.requestId, input.requestIds),
            inArray(recommendationRequestItems.listingId, input.listingIds),
          ),
        )
    },

    async findNegativeFeedbackEvents(input) {
      return findNegativeFeedbackEventsQuery(db, input)
    },
  }
}
