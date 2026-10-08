import { z } from 'zod'
import { FeedbackIdSchema, UserIdSchema } from '../system/public-id'

/**
 * Feedback Domain Contract（#463）：用户提交意见反馈 → 管理端受理 / 回复 → 用户查看结果。
 *
 * 边界：
 * - **联系方式只对本人与管理员可见**：`contact` 出现在「我的反馈」与管理端 DTO，
 *   不进入任何公开投影；服务端日志不打印它。
 * - `handlingNote` 只给管理员看（与举报 `handlingReason` 同口径）；`reply` 是写给用户的回复。
 * - 处理反馈只写结果与回复，**不触发任何治理动作**；举报 / 交易纠纷有各自的域（#73 / #465）。
 * - 列表统一游标分页（`{ items, nextCursor }`），`limit` 服务端封顶 50。
 */

// ---------------------------------------------------------------------------
// 枚举（镜像 DB：packages/db/src/schema/feedback.ts）
// ---------------------------------------------------------------------------

/**
 * 反馈类型。与小程序反馈页 `FEEDBACK_TYPE_KEYS`（`bug/ux/dispute/report/account/other`）一一对应；
 * 清单定稿归 #399。
 */
export const FeedbackTypeSchema = z.enum(['BUG', 'UX', 'DISPUTE', 'REPORT', 'ACCOUNT', 'OTHER'])
export type FeedbackType = z.infer<typeof FeedbackTypeSchema>

/** 状态机：PENDING → REPLIED（已回复）/ CLOSED（不回复直接结单）。终态不可再变。 */
export const FeedbackStatusSchema = z.enum(['PENDING', 'REPLIED', 'CLOSED'])
export type FeedbackStatus = z.infer<typeof FeedbackStatusSchema>

/** 管理员处理结果：只能把未决反馈变成这两个终态。 */
export const FeedbackHandleResultSchema = z.enum(['REPLIED', 'CLOSED'])
export type FeedbackHandleResult = z.infer<typeof FeedbackHandleResultSchema>

/** 正文长度：与小程序反馈页的校验一致（少于 5 字不合格，上限 500）。 */
export const FEEDBACK_CONTENT_MIN = 5
export const FEEDBACK_CONTENT_MAX = 500
export const FEEDBACK_CONTACT_MAX = 100
export const FEEDBACK_REPLY_MAX = 500

/** 频控：同一用户滚动 24 小时内最多提交这么多条（幂等重放不计）。 */
export const FEEDBACK_DAILY_LIMIT = 10

// ---------------------------------------------------------------------------
// 用户端
// ---------------------------------------------------------------------------

export const FeedbackCreateInputSchema = z.strictObject({
  /**
   * 客户端生成的幂等键（UUID）。重复点击 / 超时重试带同一个键 → 返回已存在的那条，不重复建单。
   * 同键不同内容视为客户端 bug，同样返回已存在的那条（以首次提交为准）。
   */
  clientRequestId: z.uuid(),
  type: FeedbackTypeSchema,
  content: z.string().trim().min(FEEDBACK_CONTENT_MIN).max(FEEDBACK_CONTENT_MAX),
  /** 用户自愿留的联系方式（手机号 / 微信号 / 邮箱），可空；只对本人与管理员可见。 */
  contact: z.string().trim().min(1).max(FEEDBACK_CONTACT_MAX).optional(),
})
export type FeedbackCreateInput = z.infer<typeof FeedbackCreateInputSchema>

/** 「我的反馈」里的一条（本人视角：含自己留的联系方式与管理员回复，不含内部处理备注）。 */
export const FeedbackSchema = z.object({
  id: FeedbackIdSchema,
  type: FeedbackTypeSchema,
  content: z.string(),
  contact: z.string().nullable(),
  status: FeedbackStatusSchema,
  /** 管理员写给用户的回复；未回复或直接结单为 null。 */
  reply: z.string().nullable(),
  createdAt: z.iso.datetime(),
  /** 处理完成时刻；未处理为 null（前端据此展示「处理中」）。 */
  handledAt: z.iso.datetime().nullable(),
})
export type Feedback = z.infer<typeof FeedbackSchema>

/** 提交返回。幂等重放也是 200 + `created: false`（同举报口径：重试对客户端无感）。 */
export const FeedbackCreateResponseSchema = z.object({
  feedback: FeedbackSchema,
  created: z.boolean(),
})
export type FeedbackCreateResponse = z.infer<typeof FeedbackCreateResponseSchema>

export const FeedbackListResponseSchema = z.object({
  items: z.array(FeedbackSchema),
  nextCursor: z.string().nullable(),
})
export type FeedbackListResponse = z.infer<typeof FeedbackListResponseSchema>

export const FeedbackMineQuerySchema = z.strictObject({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})
export type FeedbackMineQuery = z.infer<typeof FeedbackMineQuerySchema>

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export const AdminFeedbackQueueQuerySchema = z.strictObject({
  /** 按状态筛选，缺省 = 全部状态。 */
  status: FeedbackStatusSchema.optional(),
  type: FeedbackTypeSchema.optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})
export type AdminFeedbackQueueQuery = z.infer<typeof AdminFeedbackQueueQuerySchema>

export const FeedbackUserSummarySchema = z.object({
  id: UserIdSchema,
  nickname: z.string(),
})
export type FeedbackUserSummary = z.infer<typeof FeedbackUserSummarySchema>

export const AdminFeedbackItemSchema = z.object({
  feedback: FeedbackSchema.safeExtend({
    /** 内部处理备注，只给管理员看。 */
    handlingNote: z.string().nullable(),
    handledBy: FeedbackUserSummarySchema.nullable(),
  }),
  submitter: FeedbackUserSummarySchema,
})
export type AdminFeedbackItem = z.infer<typeof AdminFeedbackItemSchema>

export const AdminFeedbackListResponseSchema = z.object({
  items: z.array(AdminFeedbackItemSchema),
  nextCursor: z.string().nullable(),
})
export type AdminFeedbackListResponse = z.infer<typeof AdminFeedbackListResponseSchema>

/**
 * 管理员处理反馈。
 *
 * - `REPLIED` 必须带 `reply`（写给用户看的回复）；
 * - `CLOSED` 不得带 `reply`（直接结单，用户只看到「已处理」）；
 * - `note` 是内部备注，两种结果都必填，进审计。
 */
export const AdminFeedbackHandleInputSchema = z
  .strictObject({
    result: FeedbackHandleResultSchema,
    reply: z.string().trim().min(1).max(FEEDBACK_REPLY_MAX).optional(),
    note: z.string().trim().min(1).max(500),
  })
  .superRefine((value, ctx) => {
    if (value.result === 'REPLIED' && value.reply === undefined) {
      ctx.addIssue({ code: 'custom', path: ['reply'], message: '回复用户时必须填写回复内容' })
    }
    if (value.result === 'CLOSED' && value.reply !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['reply'], message: '直接结单时不能附带回复' })
    }
  })
export type AdminFeedbackHandleInput = z.infer<typeof AdminFeedbackHandleInputSchema>

// ---------------------------------------------------------------------------
// 错误码
// ---------------------------------------------------------------------------

export const FeedbackErrorCodeSchema = z.enum([
  /** 反馈不存在。 */
  'FEEDBACK_NOT_FOUND',
  /** 已被其它管理员处理 / 重复处理。 */
  'FEEDBACK_CONFLICT',
  /** 超过 24 小时提交上限。 */
  'FEEDBACK_RATE_LIMITED',
])
export type FeedbackErrorCode = z.infer<typeof FeedbackErrorCodeSchema>
