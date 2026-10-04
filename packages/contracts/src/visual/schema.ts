import { z } from 'zod'
import { ALLOWED_IMAGE_MIME, ListingCardSchema, ListingCategorySchema } from '../listings/schema'

/**
 * 拍照识图搜索（#324）契约。
 *
 * 与 `GET /listings?q=` 分离：那条路是**文本**检索（ILIKE 标题/描述），这条路的输入是**图片**，
 * 且必须承载「查询图私有、短 TTL、不是 Listing 媒体」的语义。复用同一个入口会让
 * "查询图" 看起来像一个可选参数，而它实际上是一次完整的临时对象生命周期。
 */

/**
 * 查询图对象键前缀。与 Listing 图片的三个前缀（`listings/` 公开、`listing-media/` 私有 staging、
 * `listing-review-media/` 人工审核）并列，但**永远不会**出现在 Listing 的图片组里：
 * `assertUsableObjectKeys` 只接受 `listings/…` 前缀，查询图因此不可能被"顺手"引用成商品图。
 */
export const VISUAL_QUERY_IMAGE_PREFIX = 'visual-search/'

/** 查询图大小上限，与 Listing 图片一致（`MAX_IMAGE_BYTES`）。更大的图没有任何检索收益。 */
export const MAX_VISUAL_QUERY_IMAGE_BYTES = 5 * 1024 * 1024

/**
 * 查询图像素上限（解压炸弹护栏）。
 *
 * 5MB 的 JPEG 可以解出上亿像素（`20000x20000` 单色 JPEG 不到 1MB），而上游按图 token 计费，
 * 像素越多越贵、越慢。2500 万像素 ≈ 6000x4200，已超过任何手机摄像头的长边。
 */
export const MAX_VISUAL_QUERY_IMAGE_PIXELS = 25_000_000

/**
 * 查询图存活时间。上限取 15 分钟：一次搜索的合理生命周期是"选图→识别→看结果"，
 * 超过这个窗口的对象**必须**已被清理任务删除（M2 的"短 TTL"）。
 */
export const VISUAL_QUERY_IMAGE_TTL_SECONDS = 900

/**
 * 上传查询图时 presign 的有效期，比 Listing staging 的 600s 更短：
 * 客户端拿到 URL 后应当**立即** PUT，长窗口只是给泄漏的 URL 更多可用时间。
 */
export const VISUAL_QUERY_PRESIGN_EXPIRES_SECONDS = 300

/**
 * 错误码（Issue #324「错误语义至少区分」）。
 *
 * `VISUAL_SEARCH_PROVIDER_UNAVAILABLE` 与 `VISUAL_SEARCH_NO_EMBEDDING` 必须与
 * "没有找到相似商品" 分开：上游 5xx 伪装成空结果会让用户以为"这个商品没人卖"，
 * 也会让运维看不到上游故障。
 */
export const VISUAL_SEARCH_ERROR_CODES = [
  'VISUAL_SEARCH_IMAGE_INVALID',
  'VISUAL_SEARCH_IMAGE_TOO_LARGE',
  'VISUAL_SEARCH_PROVIDER_UNAVAILABLE',
  'VISUAL_SEARCH_RATE_LIMITED',
  'VISUAL_SEARCH_NO_EMBEDDING',
] as const

export type VisualSearchErrorCode = (typeof VISUAL_SEARCH_ERROR_CODES)[number]

export const VisualQueryImageMimeSchema = z.enum(ALLOWED_IMAGE_MIME)

/** 查询图 MIME（= 商品图白名单），与 `VisualImageMime` 同值：前者给 API 契约用，后者给 provider 用。 */
export type VisualQueryImageMime = z.infer<typeof VisualQueryImageMimeSchema>

/**
 * 查询图上传请求。`contentType` / `sizeBytes` 只是**预检**：服务端在搜索时会
 * `stat` 对象并按魔术字节重新嗅探，客户端声明的 MIME 从不被信任。
 */
export const VisualQueryUploadRequestSchema = z.strictObject({
  contentType: VisualQueryImageMimeSchema,
  sizeBytes: z.number().int().min(1).max(MAX_VISUAL_QUERY_IMAGE_BYTES),
})

export const VisualQueryUploadResponseSchema = z.strictObject({
  objectKey: z.string().min(1),
  url: z.url(),
  /**
   * 预签名 PUT 的过期时刻（`VISUAL_QUERY_PRESIGN_EXPIRES_SECONDS`，刻意短于查询图台账 TTL）。
   * **不是**"查询图还能被搜索"的期限：PUT 必须在此之前完成，此后对象仍可在台账 TTL 内被搜索。
   */
  expiresAt: z.iso.datetime(),
})

export type VisualQueryUploadResponse = z.infer<typeof VisualQueryUploadResponseSchema>

/**
 * 排序档位（#324 M6）。
 *
 * 服务端在**截断前**排序，所以客户端拿到的 30 条就是该档位的全局前 30 条，
 * 而不是"对已返回的 30 条本地重排"。
 *
 * 五个档位只改**呈现顺序**、不改分数，因此既不进 `VISUAL_RANKING_WEIGHTS`，
 * 也不递增 `VISUAL_SEARCH_STRATEGY_VERSION`。中文标签（综合/热销/最新/价格/成色）
 * 留在客户端映射：契约只认稳定标识符，改文案不该是破坏性变更。
 */
export const VISUAL_SEARCH_SORTS = [
  'relevance',
  'popular',
  'newest',
  'price_asc',
  'condition',
] as const

export const VisualSearchSortSchema = z.enum(VISUAL_SEARCH_SORTS)

export type VisualSearchSort = z.infer<typeof VisualSearchSortSchema>

/**
 * 搜索请求只接受**已上传**的 `objectKey`，不接受 multipart：
 * 上传与搜索分开，才能让"上传失败"和"识别失败"有各自的错误码与重试语义。
 */
export const VisualSearchRequestSchema = z.strictObject({
  objectKey: z.string().min(1).max(512),
  /**
   * 缺省 = `relevance`。刻意 `.optional()` 而不是 `.default('relevance')`：
   * 老客户端与并行开发的 M9 回放脚本仍在发 `{ objectKey }`，带默认值会让解析结果类型
   * 在类型层上把它变成必填，等于用类型把老调用方证伪。缺省值由服务端补。
   */
  sort: VisualSearchSortSchema.optional(),
})

/**
 * OCR/VLM 解析结果（M5）。**严格 schema**：模型返回的任何多余字段都会被 zod 剥掉，
 * 缺字段就是缺字段——`null` 表示"这一路没有结论"，绝不用空串/占位值伪造。
 */
export const VisualInterpretationSchema = z.strictObject({
  /** 图中识别到的完整文字（教材封面、型号标签等）。 */
  text: z.string().min(1).optional(),
  category: ListingCategorySchema.optional(),
  brand: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  /** 检索关键词；上限 8 个是为了让"文本路"不因为模型话多而退化成一坨噪声。 */
  keywords: z.array(z.string().min(1)).min(1).max(8).optional(),
})

export type VisualInterpretation = z.infer<typeof VisualInterpretationSchema>

/**
 * 结果项（#324 M6）：卡片 +「N 人想要」。
 *
 * 想要数放在卡片**外层**而不是 `ListingCardSchema` 上：它是搜索结果的语境信号，
 * 公开 Feed / 详情今天并不投影它；塞进 `ListingCard` 会让每个列表查询都被迫多查一次收藏表。
 */
export const VisualSearchResultItemSchema = ListingCardSchema.extend({
  /** 想要数（收藏数）。由候选信号批量查出，不逐条补查。 */
  favoriteCount: z.number().int().nonnegative(),
})

export type VisualSearchResultItem = z.infer<typeof VisualSearchResultItemSchema>

/**
 * 判定「成交均价」是否可信的最小样本数（#324 M6）。
 *
 * 少于这个数就不给均价：2 件商品的"均价"不是行情，而是一个会让卖家按错误价格定价的数字。
 * 阈值锁在服务端，客户端各判一次就会各漂一次。
 */
export const VISUAL_SOLD_AVG_MIN_SAMPLES = 3

/**
 * 成交均价统计（#324 M6）。
 *
 * 口径：**解析出的类目**下 `status = 'SOLD'` 商品的 `priceCents` 平均值。不走 transactions 表、
 * 不加时间窗口——这个数字回答的是"这个类目大概卖多少钱"，不是某一笔成交的复盘。
 * 已登录请求者**自己**的已成交商品不计入（#406 第 2 项）：本人的成交价不该混进他正在参考的行情，
 * 与召回侧"不返回本人商品"同一口径；匿名请求没有可排除的主体，口径不变。
 *
 * 样本不足时 `soldAvgPriceCents = null`，但 `soldSampleCount` 仍如实返回：
 * 客户端要能显示"样本不足（2 件）"，而不是把它当成"没有统计"。
 */
export const VisualSearchStatsSchema = z.strictObject({
  soldAvgPriceCents: z.number().int().nonnegative().nullable(),
  soldSampleCount: z.number().int().nonnegative(),
})

export type VisualSearchStats = z.infer<typeof VisualSearchStatsSchema>

/**
 * 搜索响应。**不暴露** score / distance / 各分项：内部打分是排序实现，一旦进契约就
 * 变成前端可依赖的接口，调权重就成了破坏性变更。
 *
 * 暴露 `strategyVersion`/`embeddingModel`：M6 要求它们可记录、可回放，
 * 排查"为什么昨天的结果不一样"时客户端日志里必须有这两个值。
 */
export const VisualSearchResponseSchema = z.strictObject({
  queryId: z.uuid(),
  interpretation: VisualInterpretationSchema.nullable(),
  strategyVersion: z.string().min(1),
  embeddingModel: z.string().min(1),
  items: z.array(VisualSearchResultItemSchema),
  /** 类目行情（成交均价）。与 `items` 独立：没有结果也可能有行情，反之亦然。 */
  stats: VisualSearchStatsSchema,
})

export type VisualSearchResponse = z.infer<typeof VisualSearchResponseSchema>

/** 对象键里的一级主体：登录用户用 userId，匿名用会话标识（都由服务端派生）。 */
const SUBJECT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const FILE_PATTERN = /^[A-Za-z0-9_-]{1,64}\.(?:jpg|png|webp)$/

/** 生成查询图对象键。presign 与搜索校验必须调用同一个函数，否则会演化成"生成的键通不过自己的校验"。 */
export function visualQueryImageKey(subject: string, fileId: string, ext: 'jpg' | 'png' | 'webp') {
  return `${VISUAL_QUERY_IMAGE_PREFIX}${subject}/${fileId}.${ext}`
}

/** 查询图键的归属校验：形状 + 主体白名单。前缀里带主体是不新增表就能防住"引用他人查询图"的关键。 */
export function isVisualQueryImageKey(key: string): boolean {
  if (!key.startsWith(VISUAL_QUERY_IMAGE_PREFIX)) return false
  const parts = key.slice(VISUAL_QUERY_IMAGE_PREFIX.length).split('/')
  if (parts.length !== 2) return false
  const [subject, file] = parts
  return SUBJECT_PATTERN.test(subject ?? '') && FILE_PATTERN.test(file ?? '')
}

/** 从键里取回主体（归属校验用）；形状不合法返回 null。 */
export function visualQueryImageSubject(key: string): string | null {
  if (!isVisualQueryImageKey(key)) return null
  return key.slice(VISUAL_QUERY_IMAGE_PREFIX.length).split('/')[0] ?? null
}
