import { z } from 'zod'

/**
 * 推荐指标契约（Issue #323 / R6 §3.3）：`GET /admin/recommendations/metrics` 的响应形状。
 *
 * 与 `AdminOverviewSchema` 同族（#73）：**固定口径的计数卡片**，窗口只能从白名单里选，
 * 每个字段的口径写在字段注释里而不是文档里——读接口的人先看契约。
 *
 * 三条贯穿本文件的约定，读之前必须知道：
 *
 * 1. **比率一律 `nullable`**：分母为 0 时是 `null` 而不是 0。0 会被读成"转化极差"，
 *    而"这个窗口里根本没有曝光"是另一回事。
 * 2. **`window` 是事件轴窗口**（`recommendation_events.occurred_at` / 请求轴 `requested_at`），
 *    不是写入时刻（`created_at`）。离线补发的事件带真实发生时刻，按写入时刻切窗会把旧行为算进今天。
 * 3. **进程内字段单列**（见 `RecommendationGuardrailsSchema` 的注释）：延迟与失败率是
 *    "自本进程启动以来"的单进程值，多实例部署时每个实例各看一份。
 */

/** 三个窗口档位。固定枚举而不是任意时长：口径分歧（"7d 到底含不含今天零点"）要能一眼看穿。 */
export const RecommendationMetricsWindowSchema = z.enum(['24h', '7d', '30d'])

export type RecommendationMetricsWindow = z.infer<typeof RecommendationMetricsWindowSchema>

/** 窗口档位对应的毫秒数。API 与脚本共用，避免两处各写一遍 `7 * 24 * 3600 * 1000`。 */
export const RECOMMENDATION_METRICS_WINDOW_MS = {
  '24h': 86_400_000,
  '7d': 604_800_000,
  '30d': 2_592_000_000,
} as const satisfies Record<RecommendationMetricsWindow, number>

/**
 * `GET /admin/recommendations/metrics` 的查询参数。
 *
 * `window` 有默认值（`24h`）：这是"打开后台先看最近一天"的默认视角，省掉前端每次拼参数。
 * 用 `strictObject`：未知参数直接 422，而不是被静默忽略——口径类接口最怕"我传了 `window=30d`
 * 但看的是 24h"这种无声的不一致。
 */
export const RecommendationMetricsQuerySchema = z.strictObject({
  window: RecommendationMetricsWindowSchema.default('24h'),
})

/**
 * 线上漏斗（M8）。每一步都是**计数**，相邻两步的比值在 `*Rate` 字段里给出。
 *
 * 全部步骤都要求"有推荐归因"（`request_id IS NOT NULL`）：一个没有推荐上下文的 `FAVORITE`
 * 是用户自己搜到并收藏的，把它算进推荐漏斗会把推荐的效果凭空放大。
 *
 * **`*Rate` 不保证 ≤ 1，因此契约不给上界**：这些步骤是"各自独立上报的事件计数"，不是
 * 嵌套集合。`IMPRESSION` 有可见性门槛（`visibleRatio ≥ 0.5` 且停留 ≥ 1000ms），而
 * `DETAIL_VIEW` 只要用户点进详情就会上报 ⇒ `detailViews > impressions` 是正常现象
 * （实测 9 : 6），`impressionToDetailRate` 会是 1.5。服务端确证事件（`CHAT_START` 等）
 * 更是由业务请求直接落库，可以完全没有对应的 `DETAIL_VIEW`。把它当"转化率"读会误导，
 * 读作"这一步的事件量相对上一步的量级"才准确；真要严格嵌套就得按身份做会话级漏斗，
 * 与 D4（纯回放已落库数据）冲突。
 */
export const RecommendationFunnelSchema = z.object({
  /** 窗口内的推荐请求数（`recommendation_requests.requested_at`）。 */
  feedRequests: z.number().int().nonnegative(),
  /** 其中走了降级透传的请求数（`strategy_version = 'rec-v1-none'`，没有排序快照）。 */
  degradedFeedRequests: z.number().int().nonnegative(),
  /** 归因曝光数（`IMPRESSION` 且 `request_id IS NOT NULL`）。 */
  impressions: z.number().int().nonnegative(),
  /** 归因详情数（`DETAIL_VIEW` 且带归因）。 */
  detailViews: z.number().int().nonnegative(),
  /** 归因收藏数（`FAVORITE` 且带归因）。 */
  favorites: z.number().int().nonnegative(),
  /** 归因会话数（`CHAT_START` 且带归因）。 */
  chats: z.number().int().nonnegative(),
  /** 归因交易发起数（`TRANSACTION_START` 且带归因）。 */
  transactions: z.number().int().nonnegative(),
  /** 归因成交数（`PURCHASE` 且带归因）。 */
  purchases: z.number().int().nonnegative(),
  /** 曝光 → 详情。分母为 0 时 `null`；**可能 > 1**（见上方说明）。 */
  impressionToDetailRate: z.number().nonnegative().nullable(),
  detailToFavoriteRate: z.number().nonnegative().nullable(),
  /**
   * 详情 → 会话。
   *
   * **是下界**：`CHAT_START` 是服务端确证事件，只有客户端在业务请求上带了推荐头才有 `request_id`；
   * 用户在详情页点"聊一聊"时若没带上下文头，这条会话不会出现在分子里（见设计 §11 第 4 条）。
   */
  detailToChatRate: z.number().nonnegative().nullable(),
  chatToTransactionRate: z.number().nonnegative().nullable(),
  transactionToPurchaseRate: z.number().nonnegative().nullable(),
})

export type RecommendationFunnel = z.infer<typeof RecommendationFunnelSchema>

/**
 * Guardrail 指标（M8 的"不能变差"清单）。
 *
 * **`eventWriteFailureRate` / `rateLimitedRequests` / `eventRejectionReasons` 是进程内计数**
 * （决策 D5 禁止为此建表）：它们的值是"自本进程启动以来"的，进程重启清零、多实例各自为政。
 * 需要全局值就得引入指标后端或新表，与"零 schema 变更"的决定冲突。
 */
export const RecommendationGuardrailsSchema = z.object({
  /**
   * 排序请求里"快照 0 行"的比例（分母 = `strategy_version <> 'rec-v1-none'` 的请求数）。
   *
   * **看不到降级请求的空 feed**：降级请求不写快照，它返回了什么库里没有真值 ⇒ 只能把
   * `degradedFeedRequests` 与这个字段分开看（设计 §11 第 2 条）。
   */
  emptyRankedFeedRate: z.number().min(0).max(1).nullable(),
  /**
   * 重复曝光率 = 1 − 去重(身份, 商品) / **快照行数**。与离线评估同口径。
   *
   * 分母刻意是 `recommendation_request_items` 的行数（即"服务端打算展示多少条"），
   * 不是 `attributedImpressions`：曝光事件要过可见性门槛（`visibleRatio >= 0.5` 且停留
   * `>= 1000ms`）才上报，用上报量当分母会把"用户没看"错算成"没重复"。
   * 分子分母都取自同一次快照读取，故比值天然落在 [0, 1]。
   */
  repeatedExposureRate: z.number().min(0).max(1).nullable(),
  /** 曝光最集中的单个卖家占比（seller exposure concentration）。 */
  topSellerExposureShare: z.number().min(0).max(1).nullable(),
  /** 曝光最集中的前 10 个卖家合计占比。 */
  top10SellerExposureShare: z.number().min(0).max(1).nullable(),
  /**
   * 陈旧曝光率：归因曝光里，商品**当前** `status <> 'ACTIVE'`（SOLD / RESERVED / OFFLINE）的占比。
   *
   * 用的是"当前"而不是"曝光时"（没有状态历史表）⇒ 它同时把"曝光时已售"和"曝光后才售出"
   * 算进来，是陈旧曝光的**上界**（设计 §11 第 3 条）。
   */
  staleListingExposureRate: z.number().min(0).max(1).nullable(),
  /** 事件写入失败率 = 失败次数 / (成功批数 + 失败次数)；进程内。 */
  eventWriteFailureRate: z.number().min(0).max(1).nullable(),
  /**
   * 被 429 拒绝的请求数；进程内。
   *
   * 包含两类：**埋点写入**（`POST /recommendations/events`）与 **Feed 读取**
   * （`GET /recommendations/feed`）——两者各有独立令牌桶（埋点更严、Feed 更宽，见
   * `RECOMMENDATION_EVENT_RATE_LIMIT` / `RECOMMENDATION_FEED_RATE_LIMIT`），任一被拒都记一次。
   * 想只看埋点的话，把 `eventWriteFailureRate` 与 `eventRejectionReasons` 放一起看即可；
   * 刻意不再拆成两个字段，避免"桶多到看不清线上是否在被打"。
   */
  rateLimitedRequests: z.number().int().nonnegative(),
  /**
   * 事件被拒收的原因分布；进程内。
   *
   * R1 起这些原因只写服务端日志、不进响应体（`RecommendationEventIngestResponseSchema` 的注释：
   * 客户端对原因无能为力，把原因枚举写进契约就得为每种新原因改一次协议）。R6 把它们变成
   * **可读指标**——仍然不进响应体，只是从"只有翻日志才知道"升级成"打开后台就能看见"。
   */
  eventRejectionReasons: z.object({
    /** 事件声称的曝光归属在快照里查不到（没真的调过 Feed / 跨 requestId 伪造）。 */
    attributionNotFound: z.number().int().nonnegative(),
    /** `requestId` 不属于当前身份。 */
    identityMismatch: z.number().int().nonnegative(),
    /** 商品不存在。 */
    listingNotFound: z.number().int().nonnegative(),
    /** `occurredAt` 超出允许范围（客户端时钟异常 / 离线补发太久）。 */
    occurredAtOutOfRange: z.number().int().nonnegative(),
    /**
     * 客户端上报了"只能由服务端确认"的事件类型（`CHAT_START` / `COMMENT` /
     * `TRANSACTION_START` / `PURCHASE`，见 `RECOMMENDATION_SERVER_CONFIRMED_EVENT_TYPES`）。
     *
     * 契约的输入 schema 允许客户端 POST 全部 12 种 `eventType`（拒绝理由只写日志、不进响应体），
     * 所以这条原因**真的会发生**，不是理论分支。设计文档 §6.3 最初只列了 4 个桶，
     * 实现时按 `service.ts` 的真实拒绝分支补齐成 5 个：少列一个桶等于让一类拒收在指标上隐形。
     */
    serverConfirmedEventType: z.number().int().nonnegative(),
  }),
})

export type RecommendationGuardrails = z.infer<typeof RecommendationGuardrailsSchema>

/**
 * 一个延迟指标的分位数。`count = 0` 时四个分位都是 `null`。
 *
 * 采样是**环形缓冲 + 读时排序**（`apps/api/src/observability/latency.ts`）：写入 O(1) 且不分配，
 * 排序只发生在 admin 读路径上。因此分位数是**自本进程启动以来最近 N 次**的近似，
 * 不是窗口值，也不跨进程聚合。
 */
export const RecommendationLatencySchema = z.object({
  /** `feed` = Feed 请求整段处理；`events` = 事件批量写入；`pgvector` = 语义召回单次查询。 */
  metric: z.enum(['feed', 'events', 'pgvector']),
  count: z.number().int().nonnegative(),
  p50Ms: z.number().nonnegative().nullable(),
  p95Ms: z.number().nonnegative().nullable(),
  p99Ms: z.number().nonnegative().nullable(),
  maxMs: z.number().nonnegative().nullable(),
})

export type RecommendationLatency = z.infer<typeof RecommendationLatencySchema>

export const RecommendationMetricsSchema = z.object({
  window: RecommendationMetricsWindowSchema,
  /** 生成本响应的时间（ISO 8601）。 */
  generatedAt: z.string(),
  /** 本进程启动时刻（ISO 8601）：所有进程内字段的观察起点。 */
  processStartedAt: z.string(),
  funnel: RecommendationFunnelSchema,
  guardrails: RecommendationGuardrailsSchema,
  latency: z.array(RecommendationLatencySchema),
})

export type RecommendationMetrics = z.infer<typeof RecommendationMetricsSchema>
