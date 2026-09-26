import { z } from 'zod'
import { ReportIdSchema } from '../system/public-id'

/**
 * Reports Domain Contract（#73 治理半场）。
 *
 * 举报的唯一协议来源：用户端「举报 / 我的举报」与 Admin「举报队列 / 详情 / 处理」都从这里 import，
 * 禁止在别处重复定义枚举或值域。设计见 `docs/design/issue-73-changes.md` §8。
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

/** 举报对象类型。本期只支持商品与用户；留言 / 私聊消息不在范围内。 */
export const ReportTargetTypeSchema = z.enum(['LISTING', 'USER'])
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

export const ListingReportReasonSchema = z.enum(LISTING_REPORT_REASONS)
export type ListingReportReason = z.infer<typeof ListingReportReasonSchema>
export const UserReportReasonSchema = z.enum(USER_REPORT_REASONS)
export type UserReportReason = z.infer<typeof UserReportReasonSchema>

// ---------------------------------------------------------------------------
// 用户端
// ---------------------------------------------------------------------------

export const ReportCreateInputSchema = z
  .strictObject({
    targetType: ReportTargetTypeSchema,
    /** 目标 id。服务端会校验目标真实存在（且举报人不是目标本人）。 */
    targetId: z.uuid(),
    reason: ReportReasonSchema,
    /** 举报人补充说明，可空；过长由服务端拒绝。 */
    detailText: z.string().trim().min(1).max(200).optional(),
  })
  .superRefine((value, ctx) => {
    const allowed = value.targetType === 'LISTING' ? LISTING_REPORT_REASONS : USER_REPORT_REASONS
    if (!(allowed as readonly string[]).includes(value.reason)) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: `举报 ${value.targetType === 'LISTING' ? '商品' : '用户'}时不支持该原因`,
      })
    }
  })
export type ReportCreateInput = z.infer<typeof ReportCreateInputSchema>

export const ReportSchema = z.object({
  id: ReportIdSchema,
  targetType: ReportTargetTypeSchema,
  targetId: z.uuid(),
  reason: ReportReasonSchema,
  detailText: z.string().nullable(),
  status: ReportStatusSchema,
  createdAt: z.iso.datetime(),
  /** 处理完成时刻；未处理为 null（前端据此展示「处理中」）。 */
  handledAt: z.iso.datetime().nullable(),
})
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
  id: z.uuid(),
  nickname: z.string(),
})
export type ReportUserSummary = z.infer<typeof ReportUserSummarySchema>

/**
 * 被举报目标摘要。`label` 是给管理员看的展示名（商品标题 / 用户昵称）；
 * `status` 是目标当前状态（商品 status / 用户是否受限本期不在此展开，治理在 PR3）。
 */
export const ReportTargetSummarySchema = z.object({
  targetType: ReportTargetTypeSchema,
  targetId: z.uuid(),
  label: z.string(),
  /** 商品目标才有：当前 status + moderationStatus，帮助管理员判断是否还要下架。 */
  listingStatus: z.enum(['ACTIVE', 'RESERVED', 'SOLD', 'OFFLINE']).nullable(),
  moderationStatus: z.enum(['APPROVED', 'BLOCKED', 'REVIEW']).nullable(),
})
export type ReportTargetSummary = z.infer<typeof ReportTargetSummarySchema>

export const AdminReportItemSchema = z.object({
  /** 管理端可见处理原因与处理人；其余字段与用户端 DTO 一致。 */
  report: ReportSchema.extend({
    handlingReason: z.string().nullable(),
    handledBy: ReportUserSummarySchema.nullable(),
  }),
  reporter: ReportUserSummarySchema,
  target: ReportTargetSummarySchema,
  /** 同一目标收到的举报条数（含本条，不限举报人）：多个人打同一个目标时队列里能看出来。 */
  reportCount: z.number().int().min(0),
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
