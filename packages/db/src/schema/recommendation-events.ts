import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { createdAt, primaryKey, timestamptz } from './common'
import { listings } from './listings'
import { users } from './users'

/**
 * 行为事件类型（#323 §统一行为事件 的 12 类一期全集）。
 *
 * 用 pgEnum 而不是 text：事件类型是**闭集合**，线上多出一个没在契约里定义的类型
 * 只会让下游统计静默漏算；新增取值必须走一次迁移，让"扩集合"成为显式动作。
 */
export const recommendationEventTypeEnum = pgEnum('recommendation_event_type', [
  'IMPRESSION',
  'DETAIL_VIEW',
  'LONG_VIEW',
  'IMAGE_VIEW',
  'QUICK_SKIP',
  'FAVORITE',
  'UNFAVORITE',
  'CHAT_START',
  'COMMENT',
  'TRANSACTION_START',
  'PURCHASE',
  'HIDE',
])

/**
 * 召回通道。R1 的 Feed 只有 `fresh`（newest 透传），其余是 R3 的目标通道。
 *
 * `category` 由 R3 追加（Issue #323 M2 第 5 路），与
 * `packages/contracts/src/recommendation/schema.ts` 的 `RecommendationSourceSchema` 同步：
 * 两处不一致时"事件里写了 category、契约拒收"这类漂移只会在运行期暴露。
 */
export const recommendationSourceEnum = pgEnum('recommendation_source', [
  'fresh',
  'popular',
  'semantic',
  'wish',
  'category',
  'follow',
  'similar',
  'explore',
])

/**
 * 行为事件（#323 §M0）。只追加，不更新、不删除（删除是 R6 的保留期任务）。
 *
 * 幂等：`event_id` 是**客户端生成**的 UUIDv4（重试必须复用同一个 id），
 * `unique(event_id)` + `ON CONFLICT DO NOTHING` 让"重发同一批"变成 no-op，
 * 而不是在服务层先查再插（并发下会插进两行）。服务端生成 id 做不到这件事 ——
 * 只有客户端知道"这两次请求是同一条事件"。另两条部分唯一索引（曝光类按请求+商品、
 * PURCHASE 按商品）各自封掉一类"换个 event_id 就能重复写"的数据污染，见下方注释。
 *
 * 身份两列都可空，且**不互斥**：登录用户一样有匿名会话标识（同一浏览器先匿名后登录），
 * 两列同时存在是正常情况。两列全空的事件仍然要收：它算不出个人兴趣，但"这件商品被曝光过
 * 多少次"是商品级统计，不该因为拿不到身份就丢掉。
 *
 * `request_id` **不建外键**：请求上下文保留 90 天、事件保留 180 天，有外键就得先删事件；
 * 归属校验在服务层用 `recommendation_requests` 查（同一批次按 request_id 去重后一次查完）。
 *
 * `metadata` 的白名单在契约层逐 event_type 收紧（`packages/contracts/src/recommendation/schema.ts`），
 * 这里只负责存 —— 埋点表最容易变成隐私倾倒场，防线必须建在入口而不是查询侧。
 */
export const recommendationEvents = pgTable(
  'recommendation_events',
  {
    ...primaryKey(),
    /** 客户端幂等键（UUIDv4）。与 `id` 分开：`id` 仍是服务端 uuidv7 主键惯例。 */
    eventId: uuid('event_id').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    anonymousSessionId: uuid('anonymous_session_id'),
    /** 来自 `recommendation_requests.id`；搜索/分类等非推荐入口为 null。 */
    requestId: uuid('request_id'),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    eventType: recommendationEventTypeEnum('event_type').notNull(),
    /** 在**本次推荐请求**内的全局序号（跨页连续，从 0 开始）。 */
    position: integer('position'),
    source: recommendationSourceEnum('source'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    /** 客户端发生时刻（离线队列补发时保留真实时刻）；服务端缺省补 `now()`。 */
    occurredAt: timestamptz('occurred_at').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('recommendation_events_event_id_uq').on(table.eventId),
    /*
      曝光类事件的「同一请求内同一商品只记一次」在 R1 只是**客户端承诺**：端点匿名可写、
      `eventId` 由客户端自生成（换一个 UUID 就绕过去）、R1 又故意不做限流。于是同一
      (request_id, listing_id) 可以被一个坏客户端无成本地刷出任意多行 IMPRESSION ——
      曝光率、CTR 和「多次曝光无点击」的负样本全部被放大，而 R2/R4 直接拿这张表当训练数据。
      重复抑制不需要服务端真值，所以把它落成库级约束：冲突行由 `ON CONFLICT DO NOTHING`
      吞掉并计入 `duplicates`，语义上就是「客户端重发/多标签页重复上报」。
      只约束 IMPRESSION / QUICK_SKIP：这两类在契约里本就是「每次推荐请求每张卡各一次」；
      DETAIL_VIEW 允许重复（同一商品可以被反复点开），IMAGE_VIEW 更是每张图一条。
    */
    uniqueIndex('recommendation_events_impression_once_uq')
      .on(table.requestId, table.listingId, table.eventType)
      .where(sql`${table.eventType} IN ('IMPRESSION', 'QUICK_SKIP')`),
    /*
      PURCHASE 是商品级唯一事实（成交即转 SOLD）。服务层写前先查一次 `hasListingEvent`，
      但那是 check-then-insert：两个并发 confirm 可以都查到「无行」再各自插入。这条部分唯一
      索引才是并发下的真保证，`ON CONFLICT DO NOTHING` 让输家静默落空而不是 500。
    */
    uniqueIndex('recommendation_events_purchase_once_uq')
      .on(table.listingId)
      .where(sql`${table.eventType} = 'PURCHASE'`),
    index('recommendation_events_user_id_occurred_at_idx').on(table.userId, table.occurredAt),
    index('recommendation_events_listing_id_occurred_at_idx').on(table.listingId, table.occurredAt),
    /*
      R3 的 Popular 召回按**时间窗**全局聚合（`occurred_at >= now() - 14 天` 后按 listing 分组），
      而 R1 建的四条索引都以 user/listing/session 开头，带范围条件时不满足最左前缀，只能全表扫。
      这条单列索引专门给"最近 N 天的行为"这种聚合用：扫描范围由时间窗决定，不随总行数增长。
    */
    index('recommendation_events_occurred_at_idx').on(table.occurredAt),
    index('recommendation_events_request_id_idx').on(table.requestId),
    index('recommendation_events_session_id_occurred_at_idx').on(
      table.anonymousSessionId,
      table.occurredAt,
    ),
    // 契约里 IMPRESSION / QUICK_SKIP 必须带 requestId + position（superRefine），
    // 这里再镜像一条：绕过 API 的写入（脚本、运维手工 SQL）也不该造出无归因的曝光行。
    check(
      'recommendation_events_impression_requires_attribution',
      sql`${table.eventType} NOT IN ('IMPRESSION', 'QUICK_SKIP') OR (${table.requestId} IS NOT NULL AND ${table.position} IS NOT NULL)`,
    ),
    check(
      'recommendation_events_position_non_negative',
      sql`${table.position} IS NULL OR ${table.position} >= 0`,
    ),
  ],
)
