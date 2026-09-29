import { z } from 'zod'
// 包内一律用相对导入（与 `listings/schema.ts` 引 `../auth/user` 同风格）；外部消费者走
// `@fish/contracts/listings/schema` 这个 subpath。
import { ListingCardSchema, ListingCategorySchema } from '../listings/schema'
import { ListingIdSchema, MatchIdSchema, WishIdSchema } from '../system/public-id'

/**
 * Matching Domain Contract（Issue #8，2026-09-12 Freeze）。
 *
 * 本目录是匹配域协议的唯一来源：API、Worker 与 Web（含 Mock adapter）都从这里 import，
 * 禁止在别处重复定义枚举或值域。冻结内容见 Issue #8 的契约评论；
 * 该评论 §1 的代码块与此处只差两处**非语义**差异（见文件末的说明）。
 *
 * 本契约**不新增任何表/列**：`matches`（score + 三个 0–100 的分项，`packages/db/src/schema/matches.ts:21-24`）、
 * `jobs`、`notifications` 都已在 #2 冻结，够用。
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * `score >= 该值` 才落库、才建通知；也是 `/matches` 里"当前有效匹配"的下界。
 * 放契约里导出：引擎、fixture 测试与前端文案必须用同一个数，否则"为什么没匹配上"会有两种解释。
 */
export const MATCH_SCORE_THRESHOLD = 70

/**
 * 向量召回 Top-K（#322 M2）：`MATCH_WISH` / `MATCH_LISTING` 两个方向**共用**的召回上限。
 *
 * 语义是"从结构化收窄后的集合里按 cosine 距离取前 K 条"，K 之外的候选本轮不进入评估集合
 * （已有 `matches` 行的那几对仍会被重新评估，见 `engine.ts` 的评估集合定义）。
 *
 * 取 50 的理由：`/matches` 默认只展示 10 条、上限 50（`MatchListQuerySchema`），召回池要显著
 * 大于展示量，M3 的 hybrid ranking 才有可排的材料；同时 50 与本阶段"不建 ANN、小数据量下
 * exact cosine scan 足够快"的取舍相容（见 `docs/design/issue-322-matching-v2-m2.md` §6）。
 *
 * **不做 env 可配**：K 直接决定"哪些对会被评估"，让部署之间不一致会让线上匹配结果无法复现，
 * 也等于把召回策略藏进部署配置里。要调就改这个常量并走 fixture 对照（M3 冻结权重时一并做）。
 */
export const MATCH_SEMANTIC_TOP_K = 50

/**
 * 落库的 `matches.ranking_version` 取值（#322 M3）：这一行是**哪一版算法**算出来的。
 *
 * - `RANKING_VERSION_V1 = 1`：v1 三路权重（分类 0.35 / 关键词 0.35 / 价格 0.30）。
 *   语义不可用（向量缺失/过期/模型不匹配）时逐位退回这一版，`semantic_score` 记 NULL。
 * - `RANKING_VERSION = 2`：v2 四路权重（语义 + 分类 + 关键词 + 价格），`semantic_score` 落库。
 *
 * 放契约里导出：库里存的就是这个数，`docs` 与 `/matches` 的口径解释都要引用它，
 * 不允许在 worker 里另写一套字面量（`packages/db/src/schema/matches.ts` 的 CHECK 也只允许 1/2）。
 */
export const RANKING_VERSION_V1 = 1
export const RANKING_VERSION = 2

/**
 * 语义分归一化的分段线性锚点（#322 M3）：把 cosine 相似度映射到 0–100。
 *
 * `semanticScore = clamp((similarity - FLOOR) / (CEILING - FLOOR), 0, 1) × 100`
 *
 * 为什么不直接把 cosine [-1, 1] 线性拉到 0–100（Issue 明说不要这么干）：真实 embedding 的
 * 相似度集中在 0.6–0.95，直接映射会把所有对压进 60–98 这一段、失去区分度；锚点把"语义上
 * 确实相关"的区间拉开，同时让"无关但 cosine 略正"的对落到 0。
 *
 * 这两个数是**证据项**：M3 用标注 fixture（人工给定 cosine）校准后冻结；改动它们等于改排序，
 * 必须带 fixture 对照与 Top-K 排名证据。`stub` provider 的余弦尺度与真实模型不可比
 * （实测 seed 相关对 0.33–0.49），所以 stub 环境下语义项通常为 0——见
 * `docs/design/issue-322-matching-v2-m3.md` §锚点校准，不要为了 stub 调这两个数。
 */
export const SEMANTIC_SCORE_FLOOR = 0.5
export const SEMANTIC_SCORE_CEILING = 0.95

// ---------------------------------------------------------------------------
// 读模型
// ---------------------------------------------------------------------------

/**
 * 匹配读模型的公共字段。
 *
 * **只暴露总分**：`category / keyword / price` 三项拆解留在库里供引擎与重算使用，不上线——
 * 前端只需要"匹配度 xx%"，多回三个数不省计算（同一行 SELECT 就有），却会让"分数含义"
 * 变成线上协议的一部分。
 */
export const MatchBaseSchema = z.object({
  id: MatchIdSchema,
  score: z.number().int().min(0).max(100),
  createdAt: z.iso.datetime(),
})

export type MatchBase = z.infer<typeof MatchBaseSchema>

/**
 * listing 侧要展示的"对方实体"（愿望）摘要。
 *
 * 三个字段可空是**照抄 DB 真值**，不是为将来留口子：`packages/db/src/schema/wishes.ts:16-20`
 * 里 `keyword` 是 NOT NULL，而 `category`（NULL = 不限分类）/ `budget_min_cents` / `budget_max_cents` 均可空。
 *
 * `category` 用列表域的 `ListingCategorySchema`（大写 8 值）= DB pgEnum 真值，与 #6 契约同源。
 * 注意 `packages/contracts/src/wishes/schema.ts:9-17` 仍是小写枚举（#6 契约 §5.A 已提出迁移），
 * 所以同一份愿望数据经 #7 与 #8 两条路径会给出两种大小写——需要 #7 侧迁移，见 #8 契约评论 §6.6。
 */
export const WishSummarySchema = z.object({
  id: WishIdSchema,
  keyword: z.string(),
  category: ListingCategorySchema.nullable(),
  budgetMinCents: z.number().int().nonnegative().nullable(),
  budgetMaxCents: z.number().int().nonnegative().nullable(),
})

export type WishSummary = z.infer<typeof WishSummarySchema>

/** wish 侧的一行：`GET /matches?wishId=` 的对方实体是商品，直接复用 #6 冻结的卡片。 */
export const WishMatchItemSchema = MatchBaseSchema.extend({ listing: ListingCardSchema })

export type WishMatchItem = z.infer<typeof WishMatchItemSchema>

/**
 * 带上 `total`（前端要"匹配总数 / Top 3"）：这是**刻意不同于** #6 feed 的取舍——
 * #6 不给 `total` 是因为无限滚动用不到它且要多一次 COUNT（`listings/schema.ts:268-269`），
 * 而这里 `matches` 有 `(wish_id, score)` 索引，COUNT 走同一索引，且 UI 必须要这个数。
 */
export const WishMatchListResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  items: z.array(WishMatchItemSchema),
})

export type WishMatchListResponse = z.infer<typeof WishMatchListResponseSchema>

/** listing 侧的一行：对方实体是愿望。 */
export const ListingMatchItemSchema = MatchBaseSchema.extend({ wish: WishSummarySchema })

export type ListingMatchItem = z.infer<typeof ListingMatchItemSchema>

export const ListingMatchListResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  items: z.array(ListingMatchItemSchema),
})

export type ListingMatchListResponse = z.infer<typeof ListingMatchListResponseSchema>

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

/**
 * `wishId` 与 `listingId` **必须恰好给一个**。
 *
 * 匹配只能从"我的一个愿望"或"我的一个商品"看进去——没有"全站匹配列表"。
 * 归属校验（是否本人）需要当前用户 id，schema 层判不了，由 router/service 做（`403 NOT_TARGET_OWNER`）。
 *
 * `limit` 默认 10、上限 50，**没有 cursor**：匹配列表量级是个位数到几十，cursor 是为
 * "不断插入新行的长列表"（#6 的 feed）设计的；代价是超过 50 条拉不全，见契约评论 §5.1。
 */
export const MatchListQuerySchema = z
  .strictObject({
    wishId: WishIdSchema.optional(),
    listingId: ListingIdSchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(10),
  })
  .refine((value) => (value.wishId === undefined) !== (value.listingId === undefined), {
    path: ['wishId'],
    error: 'wishId 与 listingId 必须恰好提供一个',
  })

export type MatchListQuery = z.infer<typeof MatchListQuerySchema>

// ---------------------------------------------------------------------------
// 错误码：本 domain 新增的两个。其余复用 auth 的 `UNAUTHENTICATED`（401）
// 与 system 的 `VALIDATION_FAILED`（422）/ `INTERNAL_ERROR`（500）。
// ---------------------------------------------------------------------------

export const MatchingErrorCodeSchema = z.enum([
  /** 403：`wishId` / `listingId` 不是当前用户的。 */
  'NOT_TARGET_OWNER',
  /**
   * 404：目标 id 不存在，**或**是他人不可见的目标（如他人的 `OFFLINE` 商品——与 #6 的
   * "不泄漏存在性"同一口径，见补记 §9.8）。
   *
   * 与 #6 的 `LISTING_NOT_FOUND` / `NOT_LISTING_OWNER` 刻意不共用：本契约的两个码**方向无关**，
   * 否则同一件事（不是我的 / 不存在）在 wish 与 listing 两个方向上是两套码，前端要写两份分支。
   */
  'MATCH_TARGET_NOT_FOUND',
])

export type MatchingErrorCode = z.infer<typeof MatchingErrorCodeSchema>

/**
 * 与 Issue #8 契约评论 §1 代码块的非语义差异（记录用，不改任何字段语义）：
 * 1. 该代码块写的是 `import ... from '@fish/contracts/listings/schema'`（外部消费者的写法），
 *    包内实际用相对导入 `../listings/schema`；
 * 2. 本文件额外导出 `MatchBase` / `WishSummary` 等 `z.infer` 类型别名，与 #6 的风格一致。
 */
