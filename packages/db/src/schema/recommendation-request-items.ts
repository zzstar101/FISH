import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { createdAt, primaryKey } from './common'
import { listings } from './listings'
import { recommendationSourceEnum } from './recommendation-events'
import { recommendationRequests } from './recommendation-requests'

/**
 * 一次推荐请求的**服务端快照**（#323 §M7 / R4-R5 D6）。
 *
 * 每次个性化 Feed 请求把**最终返回的有序商品序列**按位次落库。存在的理由是"翻页与归因都
 * 需要一个不可变真值"：
 *
 * 1. **翻页**：`sort=newest` 时代游标可以嵌商品游标，因为"下一页"由商品的 `(created_at, id)`
 *    唯一决定。排序结果没有这种天然键——第二页必须问"第一页我到底承诺了哪 50 件、按什么顺序"，
 *    否则两次请求之间召回与排序都可能变，用户会看到重复或漏项。游标因此改成
 *    `(requestId, offset)`，本表就是那个 offset 的落点。
 * 2. **归因**：客户端上报的 `position` / `source` 从此不再是真值。曝光事件必须回答"这条曝光是
 *    第几位、来自哪路召回"，而这两件事只有服务端知道（响应刻意不暴露它们，客户端也就无从伪造）。
 *    命中本表的 `(request_id, listing_id)` 即取本表的值，忽略客户端上报。
 * 3. **可解释**：`rank_breakdown` 记下逐特征得分与贡献，线上任何一个位次都能回答"它为什么排这里"。
 *
 * 与 `recommendation_events` 的三处刻意差异：
 *
 * - **建 `request_id` 外键**（事件表刻意不建）：快照行与请求行同生共死——请求上下文被清理后，
 *   留下的位次没有任何可解释的主体。事件表不建是因为两者保留期不同（事件 180 天 > 上下文 90 天）。
 * - **建 `listing_id` 外键且 CASCADE**（与事件表一致）：商品被物理删除（"不过审可删，不保留痕迹"）
 *   后，推荐位次不该还能反查出商品。
 * - **不存卡片内容**（标题/价格/封面）：快照固定的是**序列与位次**，不是商品本身。
 *   商品改了标题就该看到新标题；把卡片冻结下来会让"内容变了"这件事在推荐流里不可见。
 *
 * 行数上界：单请求 ≤ `RECOMMENDATION_SNAPSHOT_MAX_ITEMS`（200），超上限即 `nextCursor = null`。
 * 清理随 `request_id` 级联（请求上下文保留 90 天，R6 落删除任务）。
 */
export const recommendationRequestItems = pgTable(
  'recommendation_request_items',
  {
    ...primaryKey(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => recommendationRequests.id, { onDelete: 'cascade' }),
    /**
     * 0 起的**全局**位次，跨页连续；与事件的 `position` 同一口径。
     *
     * 第二页首条的 `position` 等于第一页条数，所以 `offset` 与 `position` 同源——
     * 翻页时"已跳过多少条"和"下一条是第几位"永远是同一个数。
     */
    position: integer('position').notNull(),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    /**
     * `recallSources[0]`：按 `RECALL_CHANNEL_PRIORITY` 排过的首要通道。
     *
     * 单列冗余存一份而不是每次从 `sources` 取第一个：归因查询（按 `(request_id, listing_id)`）
     * 只需要这一列，让它可以只索引/只读一列。
     */
    primarySource: recommendationSourceEnum('primary_source').notNull(),
    /**
     * 全部召回来源，顺序即优先级（≤ `RECALL_MAX_SOURCES_PER_CANDIDATE`）。
     *
     * 用途是通道对账：一件商品同时被 semantic 与 popular 召回时，它在两路的贡献都被记下来，
     * R6 才能回答"semantic 路到底带来了多少最终曝光"。
     */
    sources: recommendationSourceEnum('sources').array().notNull(),
    /** 排序总分 `Σ normalized × weight`，值域 `[-0.50, 1.00]`。 */
    rankScore: doublePrecision('rank_score').notNull(),
    /**
     * 逐特征明细（形状由 `@fish/contracts/recommendation/rank` 的 `RankScoreBreakdownSchema` 锁死）。
     *
     * 用 `Record<string, unknown>` 而不是 import contracts 的类型：本包**不 import contracts**
     * （`packages/db` 的纪律，见 `recall-store.ts` 的注释——一切数值与形状由调用方传入/校验）。
     * 因此这里**没有**运行时的二次校验：唯一的写入方是 API 排序层（`rank/score.ts` 按
     * `RANK_FEATURE_KEYS` 构造，`service.ts` 原样透传），形状靠那一处的类型与单测保证；
     * 库层只保证它是 jsonb 对象（必须过 `jsonParam`，否则会 double-stringify 成字符串）。
     */
    rankBreakdown: jsonb('rank_breakdown').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    // 同一请求内每个位次最多一件商品。**不**额外约束 listing_id 唯一：去重是排序层的职责，
    // 库层再加一条只会把排序层的 bug 变成 500，而线上需要的是"能返回一页结果 + 一条告警"。
    uniqueIndex('recommendation_request_items_position_uq').on(table.requestId, table.position),
    // 翻页按 (request_id, position) 切片，由上面那条唯一索引服务；归因查询（按 request_id × 一批
    // listing_id）只按 request_id 走这条单列索引，**listing_id 不在任何索引键里**，商品条件是在
    // 取回行之后过滤的 —— 所以下推压的是返回行数，不是索引扫描宽度（详见 API 侧
    // `recommendation/store.ts` 的 `findRequestItemAttribution` 注释）。若将来归因查询成为热点，
    // 再把这条换成 (request_id, listing_id) 复合索引即可。
    index('recommendation_request_items_request_id_idx').on(table.requestId),
  ],
)
