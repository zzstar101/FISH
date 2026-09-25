import { z } from 'zod'
import { ListingStatusSchema } from '../listings/schema'

/**
 * 治理动作（#73 治理半场 PR3，设计 §6）。
 *
 * 与 `REPORT_DECISION` 的区别：这里是**动商品或用户状态**的高风险操作，
 * 审计里要能单独筛出「谁下架了什么」「谁封了谁」。因此一个端点一个 action，
 * 不合并成泛化的 `GOVERNANCE_ACTION`——审计筛选的价值就在粒度上。
 */
export const GovernanceActionSchema = z.enum([
  'LISTING_DELISTED',
  'LISTING_RESTORED',
  'USER_RESTRICTED',
  'USER_RESTRICTION_LIFTED',
  'USER_BANNED',
  'USER_UNBANNED',
])
export type GovernanceAction = z.infer<typeof GovernanceActionSchema>

/** 治理目标类型。限制类动作的审计目标是限制记录本身（同一用户可被多次限制）。 */
export const GovernanceTargetTypeSchema = z.enum(['LISTING', 'USER_RESTRICTION'])
export type GovernanceTargetType = z.infer<typeof GovernanceTargetTypeSchema>

/** 治理错误码。与 admin / reports 的 ErrorCodeSchema 同一形状，前端按 code 分支。 */
export const GovernanceErrorCodeSchema = z.enum([
  /** 商品或用户不存在（404）。 */
  'GOVERNANCE_TARGET_NOT_FOUND',
  /** sourceReportId 传了但举报单不存在（404）。 */
  'GOVERNANCE_SOURCE_REPORT_NOT_FOUND',
  /** 422：关联举报的目标与本次商品/用户治理目标不符。 */
  'GOVERNANCE_SOURCE_REPORT_MISMATCH',
  /** 管理员对自己执行治理动作（422）。DB 层也有 CHECK 兜底。 */
  'GOVERNANCE_SELF_TARGET',
  /** 状态前提不满足：已下架 / 未下架 / 已封禁 / 没有生效中的限制（409）。 */
  'GOVERNANCE_CONFLICT',
  /** 领域层入参不合法（422，与其它域共用系统错误码）。 */
  'VALIDATION_FAILED',
  /**
   * 受限用户直连写接口被守卫挡下（403，`governance/guard.ts`）。
   *
   * 与治理动作的错误码合用一个枚举而不是另起一个：前端处理「被限制」时只 import
   * 一处；治理动作的 `GOVERNANCE_*` 错误只会在 Admin 端出现，两者不会互相歧义。
   */
  'USER_RESTRICTED',
  /** 受保护的写请求等候同一用户治理锁超时（503，可重试；不表示账号已被限制）。 */
  'USER_GUARD_BUSY',
])
export type GovernanceErrorCode = z.infer<typeof GovernanceErrorCodeSchema>

/** 治理原因。与举报处理原因同口径：必填、1–500 字，写进审计不可抵赖。 */
export const GovernanceReasonSchema = z.string().trim().min(1).max(500)
export type GovernanceReason = z.infer<typeof GovernanceReasonSchema>

/**
 * 回链到触发本次治理的举报单（可选）。
 *
 * 治理也会在无举报时发生（管理员巡逻发现），所以是可选项而不是必填；
 * 填了就必须存在且与受处罚商品或用户相关，避免错误归因。
 */
const sourceReportIdSchema = z.uuid().optional()

/** POST /admin/listings/:id/delist */
export const GovernanceListingDelistInputSchema = z.strictObject({
  reason: GovernanceReasonSchema,
  sourceReportId: sourceReportIdSchema,
})
export type GovernanceListingDelistInput = z.infer<typeof GovernanceListingDelistInputSchema>

/** POST /admin/listings/:id/restore */
export const GovernanceListingRestoreInputSchema = z.strictObject({
  reason: GovernanceReasonSchema,
  sourceReportId: sourceReportIdSchema,
})
export type GovernanceListingRestoreInput = z.infer<typeof GovernanceListingRestoreInputSchema>

/**
 * POST /admin/users/:id/restrict-publish 与 /ban 共用输入形状。
 *
 * 两者的区别只在端点（也就是 type）与审计 action，不在字段：
 * - `restrict-publish` → `PUBLISH_RESTRICT`，禁止写入口；
 * - `ban` → `BAN`，当前行为等价，语义来源更重。
 * `expiresAt` 惰性判断（读时与 now 比较），不引入定时任务。
 */
export const GovernanceRestrictInputSchema = z.strictObject({
  reason: GovernanceReasonSchema,
  sourceReportId: sourceReportIdSchema,
  expiresAt: z.iso.datetime().optional(),
})
export type GovernanceRestrictInput = z.infer<typeof GovernanceRestrictInputSchema>

/** POST /admin/users/:id/lift-restriction：解除该用户全部生效中的限制（一次清空）。 */
export const GovernanceLiftRestrictionInputSchema = z.strictObject({
  reason: GovernanceReasonSchema,
  sourceReportId: sourceReportIdSchema,
})
export type GovernanceLiftRestrictionInput = z.infer<typeof GovernanceLiftRestrictionInputSchema>

/** 生效中 / 已解除的限制记录快照（用户详情、治理结果、Overview 共用）。 */
export const GovernanceRestrictionSchema = z.strictObject({
  id: z.uuid(),
  userId: z.uuid(),
  type: z.enum(['PUBLISH_RESTRICT', 'BAN']),
  status: z.enum(['ACTIVE', 'LIFTED']),
  reason: z.string(),
  actorUserId: z.uuid(),
  sourceReportId: z.uuid().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  liftedAt: z.iso.datetime().nullable(),
  liftedBy: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
})
export type GovernanceRestriction = z.infer<typeof GovernanceRestrictionSchema>

/**
 * 治理动作的执行结果。
 *
 * 一次调用只动一个目标，因此 `targetType` + `targetId` 单值；附带动的最新状态让前端
 * 不必再拉一次详情就能刷新（但前端仍会 invalidate 相关 query，不依赖这个字段）。
 */
export const GovernanceResultSchema = z.strictObject({
  action: GovernanceActionSchema,
  targetType: GovernanceTargetTypeSchema,
  targetId: z.uuid(),
  /** 商品治理后的 listing status（下架 / 恢复才有，其余为 null）。 */
  listingStatus: ListingStatusSchema.nullable(),
  /** 限制类动作涉及的限制记录（限制 / 解除才有；封禁与限制发布返回新建的那条）。 */
  restriction: GovernanceRestrictionSchema.nullable(),
})
export type GovernanceResult = z.infer<typeof GovernanceResultSchema>
