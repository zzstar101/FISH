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
 * 配图：**读模型保留 `images[{url}]`，写契约暂不收图**。main 上没有能产出评价可引用键的
 * 上传路径（uploads 的 presign/confirm 是 listing 审核专用、`chat-media/` 是会话域），
 * 接受任意 `objectKey` 等于允许引用别人的对象。等 `transaction-review-media` 上传链落地
 * 后，写契约加可选 `imageObjectKeys` 即可，读侧不用改。
 */

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

export const TransactionReviewCreateInputSchema = z.strictObject({
  rating: TransactionReviewRatingSchema,
  body: TransactionReviewBodySchema.optional(),
})

export type TransactionReviewCreateInput = z.infer<typeof TransactionReviewCreateInputSchema>

/** 评价里的配图（读投影）：URL 由服务端从对象键拼好，端上不接触存储布局。 */
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
])

export type TransactionReviewErrorCode = z.infer<typeof TransactionReviewErrorCodeSchema>
