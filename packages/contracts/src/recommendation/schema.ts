import { z } from 'zod'
import { ListingCardSchema } from '../listings/schema'
import { ListingIdSchema as PublicListingIdSchema } from '../system/public-id'

/**
 * Recommendation Domain Contract（Issue #323 / R1 — Event Tracking & Recommendation Context）。
 *
 * R1 只落地**归因与埋点契约**：推荐请求上下文、12 类行为事件、最小推荐 Feed 入口。
 * 多路召回、兴趣向量、ranker、re-rank 归 R2–R4；首页真实接线归 R5；指标与 guardrail 归 R6。
 *
 * 三条写进契约的决定：
 *
 * 1. **事件 id 由客户端生成（UUIDv4）**，服务端用唯一索引兜底重试幂等（`ON CONFLICT DO NOTHING`）。
 *    重试只有客户端知道「这是同一条事件」，服务端生成 id 做不到。仓库既有的客户端 id 惯例就是
 *    `crypto.randomUUID()`（`apps/web-pc/src/features/chat/outbox.ts:29`），小程序端没有原生
 *    `crypto`，用自带的生成器补齐（见 `apps/miniapp/src/lib/uuid.ts`）。
 * 2. **`requestId` 可为 `null`**：只有从推荐 Feed 点进去的浏览才有归因来源。搜索 / 分类 / 卖家主页
 *    进入详情时没有推荐请求，硬塞一个假 requestId 会把归因污染成"看起来来自推荐"。
 *    曝光类事件（`IMPRESSION` / `QUICK_SKIP`）**必须**带 `requestId` + `position`，由 superRefine 强制。
 * 3. **`metadata` 逐 event_type 白名单**：`strictObject` 直接拒绝未知键，而不是"存下来以后再说"——
 *    埋点表最容易变成隐私倾倒场，白名单是唯一能长期守住边界的机制。单条 metadata 另有 2KB 上限。
 */

// ---------------------------------------------------------------------------
// 事件类型与阈值
// ---------------------------------------------------------------------------

/** Issue #323 §统一行为事件 的 12 类事件（一期全集）。 */
export const RecommendationEventTypeSchema = z.enum([
  /** 商品真实进入可视区域（阈值见 RECOMMENDATION_THRESHOLDS）。 */
  'IMPRESSION',
  /** 打开详情。 */
  'DETAIL_VIEW',
  /** 详情停留达到 LONG_VIEW 阈值。 */
  'LONG_VIEW',
  /** 主动查看 / 切换商品图片。 */
  'IMAGE_VIEW',
  /** 短时曝光后快速划过（未点开）。 */
  'QUICK_SKIP',
  'FAVORITE',
  'UNFAVORITE',
  /** 发起会话 / 想要。 */
  'CHAT_START',
  'COMMENT',
  'TRANSACTION_START',
  'PURCHASE',
  /** 不感兴趣（一期有真实入口，见 R1 的 HIDE 埋点）。 */
  'HIDE',
])

export type RecommendationEventType = z.infer<typeof RecommendationEventTypeSchema>

/**
 * 召回通道。R1 的 Feed 是 `newest` 透传，只有 `fresh`；其余是 R3 多路召回的目标通道，
 * 现在就把枚举冻结，避免 R3 改契约。
 */
export const RecommendationSourceSchema = z.enum([
  'fresh',
  'popular',
  'semantic',
  'wish',
  'follow',
  'similar',
  'explore',
])

export type RecommendationSource = z.infer<typeof RecommendationSourceSchema>

/**
 * 客户端判定阈值**集中定义在契约里**，三端（miniapp / web-pc / 测试 fixture）共用同一份数字。
 *
 * 分散在各端实现里必然漂移：小程序用 `wx.createIntersectionObserver`、PC 用 `IntersectionObserver`，
 * 两套 API 的触发时机不同，只有阈值共享才能让两端的 `IMPRESSION` 语义可比。
 */
export const RECOMMENDATION_THRESHOLDS = {
  /** 曝光：可视面积占比 ≥ 50%。 */
  impressionMinVisibleRatio: 0.5,
  /** 曝光：持续可见 ≥ 1000ms（划过不算曝光）。 */
  impressionMinDurationMs: 1_000,
  /** 快速划过：可见时长 < 1000ms 且未点开。 */
  quickSkipMaxDurationMs: 1_000,
  /** 长浏览：详情停留 ≥ 10000ms。 */
  longViewMinDurationMs: 10_000,
} as const

/** 必须带 `requestId` + `position` 的事件类型（Feed 视口内产生的事件）。 */
export const RECOMMENDATION_FEED_ATTRIBUTED_EVENT_TYPES = ['IMPRESSION', 'QUICK_SKIP'] as const

/**
 * 服务端确证类事件：行为由服务端业务写路径确证（评论 / 会话 / 交易），**客户端写入端点拒收**。
 *
 * 这个端点匿名可写，如果照收客户端上报的这几类，任何人 POST 一批 `PURCHASE` 就能污染训练数据，
 * 而且落库后无法与真实交易区分（表里没有来源列）。拒收之后，"表里出现这四类 = 服务端写的"这条
 * 不变式在数据层面成立，不需要额外加列。
 */
export const RECOMMENDATION_SERVER_CONFIRMED_EVENT_TYPES = [
  'CHAT_START',
  'COMMENT',
  'TRANSACTION_START',
  'PURCHASE',
] as const

// ---------------------------------------------------------------------------
// metadata 白名单
// ---------------------------------------------------------------------------

/** 单条事件的 metadata 序列化上限（字节）。 */
export const MAX_RECOMMENDATION_EVENT_METADATA_BYTES = 2_048

/**
 * UTF-8 字节数。
 *
 * 不用 `TextEncoder`：这份 schema 也在小程序端跑（客户端队列发送前的 `safeParse` 自检），
 * 微信小程序 JS 运行时没有 `TextEncoder` 全局。手写一遍代价很小，但语义必须是真的字节数——
 * 用 `String.length` 会把中文/emoji 少算（UTF-16 码元数 ≠ 字节数），上限就形同虚设。
 */
function utf8ByteLength(value: string): number {
  let bytes = 0
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
  }
  return bytes
}

/**
 * 逐 event_type 的 metadata 白名单。
 *
 * 每个值都是 `strictObject`：多一个键即整条事件 422。**不放任何自由文本**——`q` / 描述 /
 * 昵称 / 学号一律不落库；R1 只允许"判定这件事本身用到的数值"。
 */
const METADATA_SCHEMAS = {
  IMPRESSION: z.strictObject({
    visibleRatio: z.number().min(0).max(1).optional(),
    durationMs: z.number().int().min(0).max(3_600_000).optional(),
    pageIndex: z.number().int().min(0).max(10_000).optional(),
  }),
  DETAIL_VIEW: z.strictObject({}),
  LONG_VIEW: z.strictObject({
    durationMs: z.number().int().min(0).max(3_600_000).optional(),
  }),
  IMAGE_VIEW: z.strictObject({
    imageIndex: z.number().int().min(0).max(49).optional(),
  }),
  QUICK_SKIP: z.strictObject({
    durationMs: z.number().int().min(0).max(3_600_000).optional(),
  }),
  FAVORITE: z.strictObject({}),
  UNFAVORITE: z.strictObject({}),
  CHAT_START: z.strictObject({}),
  COMMENT: z.strictObject({}),
  TRANSACTION_START: z.strictObject({}),
  PURCHASE: z.strictObject({}),
  HIDE: z.strictObject({}),
}

// ---------------------------------------------------------------------------
// 写入契约
// ---------------------------------------------------------------------------

/**
 * 单条行为事件。
 *
 * `listingId` 用**公开 id**（`lst_...`）：事件来自三端，客户端只见过公开 id；API 边界上再解码成
 * 内部 uuid（与 `GET /listings/:id` 同一条规则）。
 */
export const RecommendationEventInputSchema = z
  .strictObject({
    /** 客户端生成的幂等键（UUIDv4）。同一条事件重发必须复用同一个 eventId。 */
    eventId: z.uuid(),
    /** 推荐请求 id；搜索/分类等非推荐来源为 null。 */
    requestId: z.uuid().nullable().optional(),
    listingId: PublicListingIdSchema,
    eventType: RecommendationEventTypeSchema,
    /** 在**本次推荐请求**里的全局序号（跨页连续，从 0 开始）。 */
    position: z.number().int().min(0).max(10_000).nullable().optional(),
    source: RecommendationSourceSchema.nullable().optional(),
    /** 匿名会话标识（客户端生成 UUIDv4，TTL 180 天）；登录用户的真值仍以 token 解析出的 userId 为准。 */
    anonymousSessionId: z.uuid().nullable().optional(),
    /** 客户端发生时刻；缺省由服务端补 `now()`。离线队列补发时保留真实时刻。 */
    occurredAt: z.iso.datetime({ offset: true }).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((event, ctx) => {
    const metadata = event.metadata ?? {}

    const parsed = METADATA_SCHEMAS[event.eventType].safeParse(metadata)
    if (!parsed.success) {
      const unknownKeys = parsed.error.issues
        .map((issue) => issue.path.join('.'))
        .filter((path) => path.length > 0)
      ctx.addIssue({
        code: 'custom',
        path: ['metadata'],
        message:
          unknownKeys.length > 0
            ? `metadata 含不允许的字段：${unknownKeys.join(', ')}`
            : 'metadata 不合法',
      })
    } else if (utf8ByteLength(JSON.stringify(metadata)) > MAX_RECOMMENDATION_EVENT_METADATA_BYTES) {
      ctx.addIssue({
        code: 'custom',
        path: ['metadata'],
        message: `metadata 超过 ${MAX_RECOMMENDATION_EVENT_METADATA_BYTES} 字节上限`,
      })
    }

    if (
      (RECOMMENDATION_FEED_ATTRIBUTED_EVENT_TYPES as readonly string[]).includes(event.eventType)
    ) {
      if (!event.requestId) {
        ctx.addIssue({ code: 'custom', path: ['requestId'], message: '曝光类事件必须带 requestId' })
      }
      if (event.position === undefined || event.position === null) {
        ctx.addIssue({ code: 'custom', path: ['position'], message: '曝光类事件必须带 position' })
      }
    }
  })

export type RecommendationEventInput = z.infer<typeof RecommendationEventInputSchema>

/**
 * 批量写入。上限 50：客户端离线队列按批冲刷，单请求体量与写放大都可控；
 * 更大的队列继续分批发，不放大单条请求的失败面。
 */
export const RecommendationEventBatchSchema = z.strictObject({
  events: z.array(RecommendationEventInputSchema).min(1).max(50),
})

export type RecommendationEventBatch = z.infer<typeof RecommendationEventBatchSchema>

/**
 * 写入结果。接口是 fire-and-forget（202）：
 *
 * - `accepted`：新落库条数；
 * - `duplicates`：撞 `event_id` 唯一索引被丢弃的条数（重试的正常结果，不是错误）；
 * - `rejected`：通过契约校验但服务端**拒收**的条数（商品不存在 / 归属与 requestId 不符 /
 *   `occurredAt` 越界）。逐条原因写服务端日志，不占响应体：客户端对这些原因无能为力，
 *   重试也不会变好，而把原因枚举写进契约就得为每种新原因改一次协议。
 */
export const RecommendationEventIngestResponseSchema = z.strictObject({
  accepted: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
})

export type RecommendationEventIngestResponse = z.infer<
  typeof RecommendationEventIngestResponseSchema
>

// ---------------------------------------------------------------------------
// 推荐 Feed（R1：最小可用入口）
// ---------------------------------------------------------------------------

/** R1 的策略版本：透传 `newest`，没有任何个性化排序。R5 换成真实策略版本。 */
export const RECOMMENDATION_STRATEGY_VERSION_NONE = 'rec-v1-none'

/**
 * 推荐 Feed 的查询参数。**不接受 `sort` / `q` / `category`**：推荐入口不是查询接口，
 * 参数一旦长成 `GET /listings` 的复制品，两者迟早被合并（Issue #323 §M7 明确不合并）。
 */
export const RecommendationFeedQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /** 不透明字符串：服务端对 `(requestId, 底层 listing 游标)` 编码，前端禁止解析或构造。 */
  cursor: z.string().min(1).optional(),
})

export type RecommendationFeedQuery = z.infer<typeof RecommendationFeedQuerySchema>

/**
 * 推荐 Feed 响应（Issue #323 §M7 的形状）。
 *
 * - `requestId` 是本次推荐请求的 id，客户端必须原样带在曝光/详情事件上；
 * - `strategyVersion` 让线上结果可追溯到具体策略；
 * - **不含 rankScore / 特征**：内部分数不给客户端（契约层就不放字段）。
 */
export const RecommendationFeedResponseSchema = z.strictObject({
  requestId: z.uuid(),
  strategyVersion: z.string().min(1).max(64),
  items: z.array(ListingCardSchema),
  nextCursor: z.string().nullable(),
})

export type RecommendationFeedResponse = z.infer<typeof RecommendationFeedResponseSchema>
