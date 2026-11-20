import { z } from 'zod'
import {
  CommentIdSchema,
  ListingIdSchema,
  MessageIdSchema,
  ReportIdSchema,
  ReviewIdSchema,
  TransactionIdSchema,
  UserIdSchema,
  WishIdSchema,
} from '../system/public-id'
import { TransactionReviewRatingSchema } from '../transaction-reviews/schema'
import { wishCategorySchema, wishStatusSchema } from '../wishes/schema'

/**
 * Reports Domain Contract（#73 治理半场）。
 *
 * 举报的唯一协议来源：用户端「举报 / 我的举报」与 Admin「举报队列 / 详情 / 处理」都从这里 import，
 * 禁止在别处重复定义枚举或值域。设计取舍见 Issue #73。
 *
 * 边界：
 * - **处理举报 ≠ 处罚用户**：`AdminReportHandleInputSchema` 只写处理结果与原因，下架 / 限制 /
 *   封禁等治理动作是另外的端点（Admin contract），通过 `sourceReportId` 回链本举报。
 * - 用户端 DTO **不**返回 `handlingReason`：与 `moderationReason` 一样只对管理员可见
 *   （`packages/contracts/src/listings/schema.ts` 的公开商品详情也不暴露它）。
 * - 列表统一游标分页（`{ items, nextCursor }`），`limit` 服务端封顶 50。
 */

// ---------------------------------------------------------------------------
// 枚举（镜像 DB：packages/db/src/schema/reports.ts）
// ---------------------------------------------------------------------------

/**
 * 举报对象类型（#73 治理半场 + #694 M2 / M7）。
 * `MESSAGE` 只能由会话参与者中的**接收方**举报；`COMMENT` / `REVIEW` / `WISH` 由
 * 各自的可见性 / 归属决定谁能举报，正文证据一律由服务端固化，不采信客户端。
 */
export const ReportTargetTypeSchema = z.enum([
  'LISTING',
  'USER',
  'MESSAGE',
  'COMMENT',
  'REVIEW',
  'WISH',
])
export type ReportTargetType = z.infer<typeof ReportTargetTypeSchema>

/**
 * 举报原因。DB 用一张枚举同时服务两类对象，**契约层按 targetType 收敛可选子集**——
 * 组合校验放在 `ReportCreateInputSchema` 的 `superRefine` 里，给 422 与明确文案。
 */
export const ReportReasonSchema = z.enum([
  'MISLEADING',
  'PROHIBITED',
  'FRAUD',
  'SPAM',
  'HARASSMENT',
  'IMPERSONATION',
  'ABUSE',
  'OTHER',
])
export type ReportReason = z.infer<typeof ReportReasonSchema>

/** 举报状态机：PENDING → HANDLED（受理）/ REJECTED（驳回）。 */
export const ReportStatusSchema = z.enum(['PENDING', 'HANDLED', 'REJECTED'])
export type ReportStatus = z.infer<typeof ReportStatusSchema>

/** 处理结果：只能把未决举报变成这两个终态。 */
export const ReportHandleResultSchema = z.enum(['HANDLED', 'REJECTED'])
export type ReportHandleResult = z.infer<typeof ReportHandleResultSchema>

/** 每类对象允许的原因子集（grill Q2）。 */
export const LISTING_REPORT_REASONS = [
  'MISLEADING',
  'PROHIBITED',
  'FRAUD',
  'SPAM',
  'OTHER',
] as const
export const USER_REPORT_REASONS = [
  'HARASSMENT',
  'FRAUD',
  'IMPERSONATION',
  'ABUSE',
  'OTHER',
] as const
/** 私聊消息举报原因（#694 M2）。 */
export const MESSAGE_REPORT_REASONS = [
  'SPAM',
  'FRAUD',
  'HARASSMENT',
  'PROHIBITED',
  'OTHER',
] as const

export const ListingReportReasonSchema = z.enum(LISTING_REPORT_REASONS)
export type ListingReportReason = z.infer<typeof ListingReportReasonSchema>
export const UserReportReasonSchema = z.enum(USER_REPORT_REASONS)
export type UserReportReason = z.infer<typeof UserReportReasonSchema>
export const MessageReportReasonSchema = z.enum(MESSAGE_REPORT_REASONS)
export type MessageReportReason = z.infer<typeof MessageReportReasonSchema>

/**
 * 用户生成内容类目标（留言 / 交易评价 / 愿望）共用的原因子集（#694 M7）。
 * 三者都是「某个用户发布的一段内容或一条诉求」，不新增原因码，复用已有五种。
 */
export const UGC_REPORT_REASONS = ['SPAM', 'HARASSMENT', 'PROHIBITED', 'ABUSE', 'OTHER'] as const
export const CommentReportReasonSchema = z.enum(UGC_REPORT_REASONS)
export type CommentReportReason = z.infer<typeof CommentReportReasonSchema>
export const ReviewReportReasonSchema = z.enum(UGC_REPORT_REASONS)
export type ReviewReportReason = z.infer<typeof ReviewReportReasonSchema>
export const WishReportReasonSchema = z.enum(UGC_REPORT_REASONS)
export type WishReportReason = z.infer<typeof WishReportReasonSchema>

/** 每种目标允许的原因子集（按 targetType 判别）。 */
export const REPORT_REASONS_BY_TARGET = {
  LISTING: LISTING_REPORT_REASONS,
  USER: USER_REPORT_REASONS,
  MESSAGE: MESSAGE_REPORT_REASONS,
  COMMENT: UGC_REPORT_REASONS,
  REVIEW: UGC_REPORT_REASONS,
  WISH: UGC_REPORT_REASONS,
} as const satisfies Record<ReportTargetType, readonly ReportReason[]>

/** 422 文案里的目标名。 */
const TARGET_TYPE_LABELS = {
  LISTING: '商品',
  USER: '用户',
  MESSAGE: '消息',
  COMMENT: '留言',
  REVIEW: '评价',
  WISH: '愿望',
} as const satisfies Record<ReportTargetType, string>

const ReportTargetIdSchema = z.union([
  ListingIdSchema,
  UserIdSchema,
  MessageIdSchema,
  CommentIdSchema,
  ReviewIdSchema,
  WishIdSchema,
])

const TARGET_ID_SCHEMAS = {
  LISTING: ListingIdSchema,
  USER: UserIdSchema,
  MESSAGE: MessageIdSchema,
  COMMENT: CommentIdSchema,
  REVIEW: ReviewIdSchema,
  WISH: WishIdSchema,
} as const

function reportTargetMatches(value: {
  targetType: ReportTargetType
  targetId: z.infer<typeof ReportTargetIdSchema>
}): boolean {
  return TARGET_ID_SCHEMAS[value.targetType].safeParse(value.targetId).success
}

// ---------------------------------------------------------------------------
// 用户端
// ---------------------------------------------------------------------------

export const ReportCreateInputSchema = z
  .strictObject({
    targetType: ReportTargetTypeSchema,
    /** 目标 id。服务端会校验目标真实存在（且举报人不是目标本人）。 */
    targetId: ReportTargetIdSchema,
    reason: ReportReasonSchema,
    /** 举报人补充说明，可空；过长由服务端拒绝。 */
    detailText: z.string().trim().min(1).max(200).optional(),
  })
  .superRefine((value, ctx) => {
    if (!reportTargetMatches(value)) {
      ctx.addIssue({ code: 'custom', path: ['targetId'], message: '举报目标 ID 前缀不匹配' })
    }
    const allowed = REPORT_REASONS_BY_TARGET[value.targetType]
    if (!(allowed as readonly string[]).includes(value.reason)) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: `举报${TARGET_TYPE_LABELS[value.targetType]}时不支持该原因`,
      })
    }
  })
export type ReportCreateInput = z.infer<typeof ReportCreateInputSchema>

export const ReportSchema = z
  .object({
    id: ReportIdSchema,
    targetType: ReportTargetTypeSchema,
    targetId: ReportTargetIdSchema,
    reason: ReportReasonSchema,
    detailText: z.string().nullable(),
    status: ReportStatusSchema,
    createdAt: z.iso.datetime(),
    /** 处理完成时刻；未处理为 null（前端据此展示「处理中」）。 */
    handledAt: z.iso.datetime().nullable(),
  })
  .refine(reportTargetMatches, { path: ['targetId'], message: '举报目标 ID 与资源类型不匹配' })
export type Report = z.infer<typeof ReportSchema>

export const ReportListResponseSchema = z.object({
  items: z.array(ReportSchema),
  nextCursor: z.string().nullable(),
})
export type ReportListResponse = z.infer<typeof ReportListResponseSchema>

/**
 * 提交举报的返回。
 *
 * 重复举报（同一举报人 + 同一目标 + 已有未决举报）**也是 200**：直接返回已存在的那条，
 * `created: false`。不用 409 是因为网络超时重试在客户端看来是一次失败，而举报其实已经
 * 受理了——200 + 既有举报 id 让重试完全无感，也让用户端只需处理一个「受理结果」。
 */
export const ReportCreateResponseSchema = z.object({
  report: ReportSchema,
  created: z.boolean(),
})
export type ReportCreateResponse = z.infer<typeof ReportCreateResponseSchema>

/** 「我的举报」查询参数。 */
export const ReportMineQuerySchema = z.strictObject({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})
export type ReportMineQuery = z.infer<typeof ReportMineQuerySchema>

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

/** Admin 举报队列查询参数（游标分页 + 筛选）。 */
export const AdminReportQueueQuerySchema = z.strictObject({
  /** 按状态筛选，缺省 = 全部状态（队列页默认仍会传 PENDING）。 */
  status: ReportStatusSchema.optional(),
  targetType: ReportTargetTypeSchema.optional(),
  reason: ReportReasonSchema.optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})
export type AdminReportQueueQuery = z.infer<typeof AdminReportQueueQuerySchema>

/** 举报人摘要（复用 Admin 域的脱敏口径，不返回敏感字段）。 */
export const ReportUserSummarySchema = z.object({
  id: UserIdSchema,
  nickname: z.string(),
})
export type ReportUserSummary = z.infer<typeof ReportUserSummarySchema>

/**
 * 被举报目标摘要。`label` 是给管理员看的展示名（商品标题 / 用户昵称）；
 * `status` 是目标当前状态（商品 status / 用户是否受限本期不在此展开，治理在 PR3）。
 */
export const ReportTargetSummarySchema = z
  .object({
    targetType: ReportTargetTypeSchema,
    targetId: ReportTargetIdSchema,
    label: z.string(),
    /** 商品目标才有：当前 status + moderationStatus，帮助管理员判断是否还要下架。 */
    listingStatus: z.enum(['ACTIVE', 'RESERVED', 'SOLD', 'OFFLINE']).nullable(),
    moderationStatus: z.enum(['APPROVED', 'BLOCKED', 'REVIEW']).nullable(),
  })
  .refine(reportTargetMatches, { path: ['targetId'], message: '举报目标 ID 与资源类型不匹配' })
export type ReportTargetSummary = z.infer<typeof ReportTargetSummarySchema>

/**
 * 私聊消息举报的服务端取证快照（#694 M2）。只对管理端返回；`content` 仅 TEXT 有值，
 * 媒体只给出元数据与「有无可读快照」标记，字节必须走带审计的管理端媒体端点，不能伪造 URL。
 */
export const ReportMessageEvidenceSchema = z.object({
  targetType: z.literal('MESSAGE'),
  kind: z.enum(['TEXT', 'IMAGE', 'VOICE']),
  content: z.string().nullable(),
  mimeType: z.string().nullable(),
  sizeBytes: z.number().int().nullable(),
  hasMedia: z.boolean(),
  senderNickname: z.string(),
  createdAt: z.iso.datetime(),
  recalledAt: z.iso.datetime().nullable(),
})
export type ReportMessageEvidence = z.infer<typeof ReportMessageEvidenceSchema>

/**
 * 留言举报的服务端取证快照（#694 M7）：举报创建时从 comments 行读取作者与正文，
 * 留言之后被删除也不销毁这张快照。`parentId` 非空表示这是某条留言的回复。
 */
export const ReportCommentEvidenceSchema = z.object({
  targetType: z.literal('COMMENT'),
  author: ReportUserSummarySchema,
  listingId: ListingIdSchema,
  parentId: CommentIdSchema.nullable(),
  content: z.string(),
  createdAt: z.iso.datetime(),
})
export type ReportCommentEvidence = z.infer<typeof ReportCommentEvidenceSchema>

/**
 * 交易评价举报的服务端取证快照（#694 M7）：评分 / 正文 / 配图数量在举报时固化；
 * 配图字节仍走管理端媒体端点（`?index=`），快照里只存对象键，不塞进 DTO。
 */
export const ReportReviewEvidenceSchema = z.object({
  targetType: z.literal('REVIEW'),
  author: ReportUserSummarySchema,
  transactionId: TransactionIdSchema,
  rating: TransactionReviewRatingSchema,
  body: z.string().nullable(),
  imageCount: z.number().int().min(0),
  createdAt: z.iso.datetime(),
})
export type ReportReviewEvidence = z.infer<typeof ReportReviewEvidenceSchema>

/** 愿望举报的服务端取证快照（#694 M7）：关键词 / 描述 / 预算与当时状态。 */
export const ReportWishEvidenceSchema = z.object({
  targetType: z.literal('WISH'),
  owner: ReportUserSummarySchema,
  keyword: z.string(),
  description: z.string().nullable(),
  category: wishCategorySchema.nullable(),
  budgetMinCents: z.number().int().nullable(),
  budgetMaxCents: z.number().int().nullable(),
  status: wishStatusSchema,
  moderationStatus: z.enum(['APPROVED', 'PENDING_REVIEW', 'REJECTED']),
  createdAt: z.iso.datetime(),
})
export type ReportWishEvidence = z.infer<typeof ReportWishEvidenceSchema>

/** 管理端可见的目标取证快照；目标类型判别，旧客户端据 `targetType` 分流。 */
export const ReportTargetEvidenceSchema = z.discriminatedUnion('targetType', [
  ReportMessageEvidenceSchema,
  ReportCommentEvidenceSchema,
  ReportReviewEvidenceSchema,
  ReportWishEvidenceSchema,
])
export type ReportTargetEvidence = z.infer<typeof ReportTargetEvidenceSchema>

export const AdminReportItemSchema = z.object({
  /** 管理端可见处理原因与处理人；其余字段与用户端 DTO 一致。 */
  report: ReportSchema.safeExtend({
    handlingReason: z.string().nullable(),
    handledBy: ReportUserSummarySchema.nullable(),
  }),
  reporter: ReportUserSummarySchema,
  target: ReportTargetSummarySchema,
  /** 同一目标收到的举报条数（含本条，不限举报人）：多个人打同一个目标时队列里能看出来。 */
  reportCount: z.number().int().min(0),
  /** MESSAGE / COMMENT / REVIEW / WISH 目标的服务端取证快照；LISTING / USER 为 null。 */
  evidence: ReportTargetEvidenceSchema.nullable(),
})
export type AdminReportItem = z.infer<typeof AdminReportItemSchema>

export const AdminReportListResponseSchema = z.object({
  items: z.array(AdminReportItemSchema),
  nextCursor: z.string().nullable(),
})
export type AdminReportListResponse = z.infer<typeof AdminReportListResponseSchema>

/** Admin 举报详情：队列项 + 同目标的其它未决举报（便于一次处理多个人打同一目标）。 */
export const AdminReportDetailSchema = z.object({
  item: AdminReportItemSchema,
  related: z.array(ReportSchema),
})
export type AdminReportDetail = z.infer<typeof AdminReportDetailSchema>

/** Admin 处理举报。只写结果与原因，**不触发任何治理动作**。 */
export const AdminReportHandleInputSchema = z.strictObject({
  result: ReportHandleResultSchema,
  reason: z.string().trim().min(1).max(500),
})
export type AdminReportHandleInput = z.infer<typeof AdminReportHandleInputSchema>

// ---------------------------------------------------------------------------
// 错误码
// ---------------------------------------------------------------------------

export const ReportErrorCodeSchema = z.enum([
  /** 目标不存在（或已删除）。 */
  'REPORT_TARGET_NOT_FOUND',
  /** 不能举报自己。 */
  'REPORT_SELF_TARGET',
  /** 举报不存在。 */
  'REPORT_NOT_FOUND',
  /** 已被其它管理员处理 / 重复处理。 */
  'REPORT_CONFLICT',
])
export type ReportErrorCode = z.infer<typeof ReportErrorCodeSchema>
