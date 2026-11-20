import { z } from 'zod'
import {
  ListingIdSchema,
  ReviewIdSchema,
  ReviewModerationRecordIdSchema,
  TransactionIdSchema,
  UserIdSchema,
} from '../system/public-id'

/**
 * 交易评价图片人工复审队列契约（#694 M5c）。
 *
 * 只有机器 `REVIEW` 且尚未人工结算的图片进队列。管理员看得到的上下文：
 * 作者、它挂在哪笔交易/哪个商品、评价正文与评分、图片 MIME/大小、以及完整的上游审核元数据。
 *
 * **不暴露 objectKey**：图片字节走带管理员鉴权的媒体端点（`GET .../:id/media`），
 * 队列 DTO 只说明「有图可读」，不给存储布局。
 */
export const ReviewModerationDecisionSchema = z.enum(['ALLOW', 'BLOCK'])
export type ReviewModerationDecision = z.infer<typeof ReviewModerationDecisionSchema>

export const ReviewModerationQueueItemSchema = z.object({
  /** 审核记录公开 ID（rmr_）。 */
  id: ReviewModerationRecordIdSchema,
  author: z.object({ id: UserIdSchema, nickname: z.string() }),
  transaction: z.object({
    id: TransactionIdSchema,
    listing: z.object({ id: ListingIdSchema, title: z.string() }),
  }),
  /**
   * 图片当前挂着的评价上下文。图片确认后、评价提交前不存在评价，此时为 `null`；
   * 队列只列出已被评价引用的图片，所以正常路径下非空（保留 nullable 是为删除竞态兜底）。
   */
  review: z
    .object({
      id: ReviewIdSchema,
      rating: z.enum(['POSITIVE', 'NEUTRAL', 'NEGATIVE']),
      body: z.string().nullable(),
      createdAt: z.iso.datetime(),
    })
    .nullable(),
  image: z.object({
    contentType: z.string(),
    sizeBytes: z.number().int().positive(),
  }),
  /** 机器结论（队列只收 REVIEW，保留原始值便于排查）。 */
  decision: z.enum(['ALLOW', 'BLOCK', 'REVIEW']),
  provider: z.enum(['LOCAL', 'TENCENT_IMS']),
  providerRequestId: z.string().nullable(),
  policyVersion: z.string(),
  bizType: z.string().nullable(),
  suggestion: z.enum(['Pass', 'Review', 'Block']).nullable(),
  label: z.string().nullable(),
  subLabel: z.string().nullable(),
  score: z.number().min(0).max(100).nullable(),
  matchedRules: z.array(z.string()),
  matchedTermsMasked: z.array(z.string()),
  /** 内容摘要（sha256）：管理员可据此确认队列里的元数据与媒体端点的字节同源。 */
  contentDigest: z.string(),
  /** 乐观并发版本：处理时必须回传，冲突返回 409。 */
  version: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
})
export type ReviewModerationQueueItem = z.infer<typeof ReviewModerationQueueItemSchema>

export const ReviewModerationQueueQuerySchema = z.strictObject({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})
export type ReviewModerationQueueQuery = z.infer<typeof ReviewModerationQueueQuerySchema>

export const ReviewModerationQueueResponseSchema = z.object({
  items: z.array(ReviewModerationQueueItemSchema),
  nextCursor: z.string().nullable(),
})
export type ReviewModerationQueueResponse = z.infer<typeof ReviewModerationQueueResponseSchema>

/**
 * 人工决定。`version` 是读队列时拿到的乐观锁版本：管理员看到的内容与提交决定之间若已被
 * 别人处理，服务端 409，绝不用过期的判断去放行/拒绝。
 */
export const ReviewModerationDecisionInputSchema = z.strictObject({
  decision: ReviewModerationDecisionSchema,
  reason: z.string().trim().min(1).max(500),
  version: z.number().int().nonnegative(),
})
export type ReviewModerationDecisionInput = z.infer<typeof ReviewModerationDecisionInputSchema>

export const ReviewModerationDecisionResponseSchema = z.object({
  id: ReviewModerationRecordIdSchema,
  decision: ReviewModerationDecisionSchema,
  /** 同结论重复提交时为 true：放行只搬迁一次字节、只改写一次评价引用。 */
  replayed: z.boolean(),
})
export type ReviewModerationDecisionResponse = z.infer<
  typeof ReviewModerationDecisionResponseSchema
>

export const REVIEW_MODERATION_ERROR_CODES = [
  'REVIEW_MODERATION_NOT_FOUND',
  'REVIEW_MODERATION_CONFLICT',
  'REVIEW_MODERATION_INVALID_CURSOR',
  'REVIEW_MODERATION_UNAVAILABLE',
  'VALIDATION_FAILED',
] as const
export type ReviewModerationErrorCode = (typeof REVIEW_MODERATION_ERROR_CODES)[number]

export const REVIEW_MODERATION_ROUTES = {
  queue: '/admin/reviews/moderation',
  decision: (recordId: string) => `/admin/reviews/moderation/${recordId}/decision`,
  media: (recordId: string) => `/admin/reviews/moderation/${recordId}/media`,
} as const
