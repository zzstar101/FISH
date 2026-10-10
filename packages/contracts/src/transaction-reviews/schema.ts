/**
 * Transaction Review Domain 契约（Issue #195 PR2）。
 *
 * #195 的评价口径已由 Owner 冻结（见 issue 评论与 `packages/db/src/schema/transaction-reviews.ts`
 * 的表注释），本模块把它收到 HTTP 边界：
 *
 * - 仅 `COMPLETED` 交易的 buyer / seller 可评，**各方一条**（DB 唯一索引兜底，写接口先行校验）；
 * - 评分是**三档枚举**（好评 / 中评 / 差评），不是 1..5 连续星级；
 * - 正文**可空**（只打分不写评语是正常形态），长度上限契约收口（DB 是裸 `text`）；
 * - 评价**不可修改**；本人可物理删除（删除幂等）；
 * - 评价时间用服务端 `created_at`，端上不本地造假时间。
 *
 * 配图（#475 起）：读模型 `images[{url}]`，写契约收**可选**的 `imageObjectKeys`。键**只能**来自
 * `POST /transactions/:id/review/media/confirm` 固化的 final 键（`reviews/{usr_…}/…`，见下方
 * `ReviewMediaPresignRequestSchema` 一段），服务端按前缀与归属复核 —— 直接接受任意 `objectKey`
 * 等于允许引用别人的对象。数组下标即 `sort_order`（0 = 第一张）。读侧形状未变，不用改。
 */

import { ALLOWED_IMAGE_MIME, MAX_IMAGE_BYTES } from '@fish/contracts/listings/schema'
import { ReviewIdSchema, TransactionIdSchema } from '@fish/contracts/system/public-id'
import { transactionDtoSchema, transactionRoleSchema } from '@fish/contracts/transactions/schema'
import { z } from 'zod'

/** 评价档次：好评 / 中评 / 差评（#195 冻结口径，与 DB 枚举 `transaction_review_rating` 同值集）。 */
export const TransactionReviewRatingSchema = z.enum(['POSITIVE', 'NEUTRAL', 'NEGATIVE'])
export type TransactionReviewRating = z.infer<typeof TransactionReviewRatingSchema>

/** 评语上限。与 `comments.content`（200）同一量级：评语是附言不是长文。 */
export const REVIEW_BODY_MAX = 200

/**
 * 评语。`trim` 后**允许空串**：空串 / 缺省 / 全空白同义 = 「只打分没写字」，落库为 `null`
 * （DB 的 `body` 可空，不用空串冒充「没写」）。超长才拒。
 */
export const TransactionReviewBodySchema = z.string().trim().max(REVIEW_BODY_MAX)

/**
 * 评价配图张数上限（#475）。0..N 的冻结口径在此落成具体值：3 张 —— 评价配图是成交佐证
 * 而不是主图库（listing 的 `MAX_LISTING_IMAGES = 9` 是另一个量级）。
 * 契约与 API 写校验共用本常量；端上直接 import（全仓惯例，不复制字面量）。
 */
export const MAX_REVIEW_IMAGES = 3

/** 单个对象键的形状上限（服务端键域函数还会校验前缀与归属，这里只挡长度）。 */
const ReviewImageObjectKeySchema = z.string().min(1).max(200)

export const TransactionReviewCreateInputSchema = z.strictObject({
  rating: TransactionReviewRatingSchema,
  body: TransactionReviewBodySchema.optional(),
  /**
   * 评价配图（#475）：**只能**填 `POST /transactions/:id/review/media/confirm` 返回的 final
   * 键（`reviews/{usr_…}/{med_…}.{ext}`）。数组下标即 `sort_order`（0 = 第一张）。
   * 跨用户键、他人 listing 键、chat-media 键、未确认键一律由服务端 422
   * `REVIEW_IMAGE_INVALID` 拒绝；重复键在契约层即拦（VALIDATION_FAILED）。
   */
  imageObjectKeys: z
    .array(ReviewImageObjectKeySchema)
    .max(MAX_REVIEW_IMAGES, `最多上传 ${MAX_REVIEW_IMAGES} 张图片`)
    .refine((keys) => new Set(keys).size === keys.length, {
      message: '图片对象键不能重复',
    })
    .optional(),
})

export type TransactionReviewCreateInput = z.infer<typeof TransactionReviewCreateInputSchema>

/** 评价里的配图（读投影）：URL 由服务端从对象键拼好，端上不接触存储布局。 */
/**
 * 评价配图上传链的请求/响应（#475）。
 *
 * 与 listing 的上传链同形但**独立成链**（票内决策：不动 `/uploads/*` 的既有 listing 语义）：
 * - presign 只签 staging 前缀 `transaction-review-media/{usr_…}/{med_…}.{ext}`（服务端生成键）；
 * - confirm 校验（形状/归属/存在/大小/MIME/真实图片）后写入公开的 `reviews/{usr_…}/{med_…}.{ext}`；
 * - 客户端直传 `PUT` 用 presign 返回的 `uploadUrl`，`objectKey` 视为不透明字符串。
 */
export const ReviewMediaPresignRequestSchema = z.strictObject({
  contentType: z.enum(ALLOWED_IMAGE_MIME),
  sizeBytes: z.number().int().min(1).max(MAX_IMAGE_BYTES),
})

export type ReviewMediaPresignRequest = z.infer<typeof ReviewMediaPresignRequestSchema>

export const ReviewMediaPresignResponseSchema = z.object({
  uploadUrl: z.url(),
  /** staging 键：**不能**进 `imageObjectKeys`（不在公开读白名单，引用校验只认 confirm 的 final 键）。 */
  objectKey: z.string().min(1),
  /** 直传 PUT 需原样附带的头（当前实现为空对象，字段保留供换实现时前端不改）。 */
  headers: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
})

export type ReviewMediaPresignResponse = z.infer<typeof ReviewMediaPresignResponseSchema>

export const ReviewMediaConfirmRequestSchema = z.strictObject({
  objectKey: z.string().min(1).max(200),
})

export type ReviewMediaConfirmRequest = z.infer<typeof ReviewMediaConfirmRequestSchema>

export const ReviewMediaConfirmResponseSchema = z.object({
  /** 固化后的 final 键（`reviews/{usr_…}/{med_…}.{ext}`）——这才是能进 `imageObjectKeys` 的值。 */
  objectKey: z.string().min(1),
  url: z.url(),
})

export type ReviewMediaConfirmResponse = z.infer<typeof ReviewMediaConfirmResponseSchema>

export const TransactionReviewImageSchema = z.object({
  url: z.url(),
})

export type TransactionReviewImage = z.infer<typeof TransactionReviewImageSchema>

/**
 * 一条交易评价。`authorId` 刻意不在读模型里：读方要么是作者本人（`reviewEdge`），
 * 要么拿到了带 `authorRole` 的列表（`ofTransaction`），作者身份由外层承载；
 * 把 uuid 直接翻出来既没必要也不该出现在公开边界。
 */
export const TransactionReviewSchema = z.object({
  id: ReviewIdSchema,
  transactionId: TransactionIdSchema,
  rating: TransactionReviewRatingSchema,
  body: z.string().nullable(),
  images: z.array(TransactionReviewImageSchema),
  createdAt: z.iso.datetime(),
})

export type TransactionReview = z.infer<typeof TransactionReviewSchema>

/**
 * 「我发过的评价」里的一行（`GET /me/comments?kind=review`）：评价 + 它所属交易的
 * 查看者视角 DTO。`transaction.role` / `counterpart` / `listing` 由服务端按查看者拼好，
 * 端上点行进订单详情（真实 `transactionId`）或商品（真实 `listingId`），不靠标题猜 ID。
 */
export const TransactionReviewItemSchema = z.object({
  review: TransactionReviewSchema,
  transaction: transactionDtoSchema,
})

export type TransactionReviewItem = z.infer<typeof TransactionReviewItemSchema>

/**
 * 一笔交易的两方评价（`GET /transactions/:id/reviews`）。**至多两行、不分页**：
 * 冻结口径是买卖双方各一条，行数就是 0..2。
 *
 * `authorRole` 告诉端上这条是谁写的（订单页「买家评了 / 卖家评了」各一块）；
 * 作者的用户摘要不内嵌 —— 订单 DTO 的 `counterpart` 已是对方，评价行不需要第二份身份投影。
 */
export const TransactionReviewsResponseSchema = z.object({
  items: z.array(
    z.object({
      review: TransactionReviewSchema,
      authorRole: transactionRoleSchema,
    }),
  ),
})

export type TransactionReviewsResponse = z.infer<typeof TransactionReviewsResponseSchema>

/** 单条评价边的响应：GET/POST 共用（POST 回 201，GET 回 200）。 */
export const TransactionReviewResponseSchema = TransactionReviewSchema
export type TransactionReviewResponse = TransactionReview

/** 删除我的评价：幂等，`deleted` 是本次实际删除的行数（0 = 本来就没有，含重复删除）。 */
export const TransactionReviewDeleteResponseSchema = z.object({
  deleted: z.number().int().nonnegative(),
})

export type TransactionReviewDeleteResponse = z.infer<typeof TransactionReviewDeleteResponseSchema>

// ---------------------------------------------------------------------------
// 错误码（`.extract()` 从信封派生，与其它域同手法）
// ---------------------------------------------------------------------------

export const TransactionReviewErrorCodeSchema = z.enum([
  /** 404：交易不存在，或存在但你不是它的 buyer/seller（同码，不泄漏存在性）。 */
  'TRANSACTION_NOT_FOUND',
  /** 404：你在这笔交易下还没有评价（`GET` 边）。 */
  'REVIEW_NOT_FOUND',
  /** 409：交易还没走到 COMPLETED（冻结口径：只有完成交易可评）。 */
  'TRANSACTION_NOT_COMPLETED',
  /** 409：你已评过这笔交易（各方一条；并发撞库唯一索引也归到这里）。 */
  'TRANSACTION_REVIEW_EXISTS',
  /** 422：评语命中服务端敏感词库（判定同 `comments`，复用 #74 规则库）。 */
  'REVIEW_CONTENT_BLOCKED',
  /**
   * 422：配图对象键不可引用（#475）。**一个稳定码覆盖全部不可引用情形**——跨用户键、
   * 他人 listing 键、chat-media 键、未经本上传链 confirm 的键、对象不存在——不区分，
   * 避免把「别人的对象是否存在」变成可探测的侧信道。
   */
  'REVIEW_IMAGE_INVALID',
  /**
   * 429：上传链请求过于频繁（#475 审查采纳——confirm 无上限等于开放不限量公开图床，
   * 按用户令牌桶兜底）。响应带 `retryAfterSeconds`。
   */
  'REVIEW_MEDIA_RATE_LIMITED',
  /** 503：对象存储未提供读取/固化能力（配置缺失），confirm 无法完成；可稍后重试。 */
  'REVIEW_MEDIA_UNAVAILABLE',
])

export type TransactionReviewErrorCode = z.infer<typeof TransactionReviewErrorCodeSchema>
