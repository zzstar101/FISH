import {
  type RecommendationMetrics,
  RecommendationMetricsSchema,
} from '@fish/contracts/admin/recommendation-metrics'
import { ADMIN_ROUTES } from '@fish/contracts/admin/routes'
import type { UserRole } from '@fish/contracts/admin/schema'
import {
  type AdminAuditLogPage,
  AdminAuditLogPageSchema,
  type AdminListingDetail,
  AdminListingDetailSchema,
  type AdminListingSummaryPage,
  AdminListingSummaryPageSchema,
  type AdminMeResponse,
  AdminMeResponseSchema,
  type AdminModerationDetail,
  AdminModerationDetailSchema,
  type AdminModerationQueue,
  AdminModerationQueueSchema,
  type AdminModerationRecords,
  AdminModerationRecordsSchema,
  type AdminOverview,
  AdminOverviewSchema,
  type AdminTransactionPage,
  AdminTransactionPageSchema,
  type AdminUserDetail,
  AdminUserDetailSchema,
  type AdminUserSummaryPage,
  AdminUserSummaryPageSchema,
} from '@fish/contracts/admin/schema'
import type { AuthStatus } from '@fish/contracts/auth/user'
import {
  type GovernanceLiftRestrictionInput,
  type GovernanceListingDelistInput,
  type GovernanceListingRestoreInput,
  type GovernanceRestrictInput,
  type GovernanceResult,
  GovernanceResultSchema,
} from '@fish/contracts/governance/schema'
import type { ModerationDecisionInput } from '@fish/contracts/moderation/schema'
import {
  type AdminReportDetail,
  AdminReportDetailSchema,
  type AdminReportHandleInput,
  type AdminReportListResponse,
  AdminReportListResponseSchema,
  type AdminReportQueueQuery,
} from '@fish/contracts/reports/schema'
import { apiRequest } from '../../lib/api-client'

/**
 * Admin 域 API（#467）：`/api` + `ADMIN_ROUTES` 的全部只读查询与治理写。
 *
 * 口径与其它域一致：这里只做「拼路径 + 发请求 + 用契约收口」，错误码到界面的映射在
 * `admin-messages.ts`。路径**只从 `ADMIN_ROUTES` 取**（契约注释明令禁止别处硬编码）。
 * 列表全部游标分页：`cursor` 缺省不带（从最新一页开始），`limit` 恒带。
 */

/** 分页大小：本模块内部口径，不外传（调用方一律走下面的 fetch* 函数）。 */
const ADMIN_PAGE_LIMIT = 20

type QueryParams = Record<string, string | number | undefined>

/** 查询串拼装：`undefined` 的键整体省略，不发空值（服务端 strictObject 会拒空串）。 */
function adminQueryPath(base: string, params: QueryParams): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value))
  }
  const qs = search.toString()
  return qs.length > 0 ? `${base}?${qs}` : base
}

// ---------------------------------------------------------------------------
// 管理员身份与概览
// ---------------------------------------------------------------------------

export async function fetchAdminMe(): Promise<AdminMeResponse> {
  return AdminMeResponseSchema.parse(await apiRequest(ADMIN_ROUTES.me))
}

export async function fetchAdminOverview(): Promise<AdminOverview> {
  return AdminOverviewSchema.parse(await apiRequest(ADMIN_ROUTES.overview))
}

export async function fetchAdminMetrics(
  window: '24h' | '7d' | '30d',
): Promise<RecommendationMetrics> {
  return RecommendationMetricsSchema.parse(
    await apiRequest(adminQueryPath(ADMIN_ROUTES.recommendationMetrics, { window })),
  )
}

// ---------------------------------------------------------------------------
// 用户
// ---------------------------------------------------------------------------

export type AdminUsersFilters = {
  q?: string
  authStatus?: AuthStatus
  role?: UserRole
}

export function adminUsersPath(filters: AdminUsersFilters, cursor?: string): string {
  return adminQueryPath(ADMIN_ROUTES.users, {
    q: filters.q,
    authStatus: filters.authStatus,
    role: filters.role,
    cursor,
    limit: ADMIN_PAGE_LIMIT,
  })
}

export async function fetchAdminUsers(
  filters: AdminUsersFilters,
  cursor?: string,
): Promise<AdminUserSummaryPage> {
  return AdminUserSummaryPageSchema.parse(await apiRequest(adminUsersPath(filters, cursor)))
}

export async function fetchAdminUserDetail(userId: string): Promise<AdminUserDetail> {
  return AdminUserDetailSchema.parse(await apiRequest(ADMIN_ROUTES.userDetail(userId)))
}

// ---------------------------------------------------------------------------
// 商品
// ---------------------------------------------------------------------------

export type AdminListingsFilters = {
  q?: string
  status?: 'ACTIVE' | 'RESERVED' | 'SOLD' | 'OFFLINE'
  sellerId?: string
  createdFrom?: string
  createdTo?: string
}

export function adminListingsPath(filters: AdminListingsFilters, cursor?: string): string {
  return adminQueryPath(ADMIN_ROUTES.listings, {
    q: filters.q,
    status: filters.status,
    sellerId: filters.sellerId,
    createdFrom: filters.createdFrom,
    createdTo: filters.createdTo,
    cursor,
    limit: ADMIN_PAGE_LIMIT,
  })
}

export async function fetchAdminListings(
  filters: AdminListingsFilters,
  cursor?: string,
): Promise<AdminListingSummaryPage> {
  return AdminListingSummaryPageSchema.parse(await apiRequest(adminListingsPath(filters, cursor)))
}

export async function fetchAdminListingDetail(listingId: string): Promise<AdminListingDetail> {
  return AdminListingDetailSchema.parse(await apiRequest(ADMIN_ROUTES.listingDetail(listingId)))
}

// ---------------------------------------------------------------------------
// 审核
// ---------------------------------------------------------------------------

export type AdminModerationRecordsFilters = {
  decision?: 'ALLOW' | 'BLOCK' | 'REVIEW'
  listingId?: string
  q?: string
  createdFrom?: string
  createdTo?: string
}

export function adminModerationQueuePath(cursor?: string): string {
  return adminQueryPath(ADMIN_ROUTES.moderationQueue, { cursor, limit: ADMIN_PAGE_LIMIT })
}

export function adminModerationRecordsPath(
  filters: AdminModerationRecordsFilters,
  cursor?: string,
): string {
  return adminQueryPath(ADMIN_ROUTES.moderationRecords, {
    decision: filters.decision,
    listingId: filters.listingId,
    q: filters.q,
    createdFrom: filters.createdFrom,
    createdTo: filters.createdTo,
    cursor,
    limit: ADMIN_PAGE_LIMIT,
  })
}

export async function fetchAdminModerationQueue(cursor?: string): Promise<AdminModerationQueue> {
  return AdminModerationQueueSchema.parse(await apiRequest(adminModerationQueuePath(cursor)))
}

export async function fetchAdminModerationRecords(
  filters: AdminModerationRecordsFilters,
  cursor?: string,
): Promise<AdminModerationRecords> {
  return AdminModerationRecordsSchema.parse(
    await apiRequest(adminModerationRecordsPath(filters, cursor)),
  )
}

export async function fetchAdminModerationDetail(recordId: string): Promise<AdminModerationDetail> {
  return AdminModerationDetailSchema.parse(
    await apiRequest(ADMIN_ROUTES.moderationDetail(recordId)),
  )
}

/**
 * 人工审核决定。`Idempotency-Key` 是契约**必填** header（1–128）：
 * 同一次弹窗的重试必须复用同一个 key（否则网络重试会被当成新请求，撞「已处理」409）；
 * 换目标必须换 key。key 的生命周期由调用方（决定弹窗）管理。
 */
export async function submitModerationDecision(
  recordId: string,
  input: ModerationDecisionInput,
  idempotencyKey: string,
): Promise<AdminModerationDetail> {
  return AdminModerationDetailSchema.parse(
    await apiRequest(ADMIN_ROUTES.moderationDecision(recordId), {
      body: JSON.stringify(input),
      headers: { 'Idempotency-Key': idempotencyKey },
      method: 'POST',
    }),
  )
}

// ---------------------------------------------------------------------------
// 举报
// ---------------------------------------------------------------------------

export type AdminReportsFilters = Pick<AdminReportQueueQuery, 'status' | 'targetType' | 'reason'>

export function adminReportsPath(filters: AdminReportsFilters, cursor?: string): string {
  return adminQueryPath(ADMIN_ROUTES.reports, {
    status: filters.status,
    targetType: filters.targetType,
    reason: filters.reason,
    cursor,
    limit: ADMIN_PAGE_LIMIT,
  })
}

export async function fetchAdminReports(
  filters: AdminReportsFilters,
  cursor?: string,
): Promise<AdminReportListResponse> {
  return AdminReportListResponseSchema.parse(await apiRequest(adminReportsPath(filters, cursor)))
}

export async function fetchAdminReportDetail(reportId: string): Promise<AdminReportDetail> {
  return AdminReportDetailSchema.parse(await apiRequest(ADMIN_ROUTES.reportDetail(reportId)))
}

/** 处理举报：204 无 body。重复处理 → 409 `REPORT_CONFLICT`（没有幂等键，靠状态机拒绝）。 */
export async function submitReportHandle(
  reportId: string,
  input: AdminReportHandleInput,
): Promise<void> {
  await apiRequest(ADMIN_ROUTES.reportHandle(reportId), {
    body: JSON.stringify(input),
    method: 'POST',
  })
}

// ---------------------------------------------------------------------------
// 交易（只读）与审计
// ---------------------------------------------------------------------------

export type AdminTransactionsFilters = {
  q?: string
  status?: 'PENDING_MEETUP' | 'COMPLETED' | 'CANCELLED'
  buyerId?: string
  sellerId?: string
  listingId?: string
  createdFrom?: string
  createdTo?: string
}

export function adminTransactionsPath(filters: AdminTransactionsFilters, cursor?: string): string {
  return adminQueryPath(ADMIN_ROUTES.transactions, {
    q: filters.q,
    status: filters.status,
    buyerId: filters.buyerId,
    sellerId: filters.sellerId,
    listingId: filters.listingId,
    createdFrom: filters.createdFrom,
    createdTo: filters.createdTo,
    cursor,
    limit: ADMIN_PAGE_LIMIT,
  })
}

export async function fetchAdminTransactions(
  filters: AdminTransactionsFilters,
  cursor?: string,
): Promise<AdminTransactionPage> {
  return AdminTransactionPageSchema.parse(await apiRequest(adminTransactionsPath(filters, cursor)))
}

export type AdminAuditFilters = {
  actorId?: string
  action?:
    | 'ADMIN_PROMOTED'
    | 'MODERATION_DECISION'
    | 'REPORT_DECISION'
    | 'LISTING_DELISTED'
    | 'LISTING_RESTORED'
    | 'USER_RESTRICTED'
    | 'USER_RESTRICTION_LIFTED'
    | 'USER_BANNED'
    | 'USER_UNBANNED'
  targetType?: 'USER' | 'LISTING' | 'MODERATION_RECORD' | 'REPORT' | 'USER_RESTRICTION'
  targetId?: string
  createdFrom?: string
  createdTo?: string
}

export function adminAuditPath(filters: AdminAuditFilters, cursor?: string): string {
  return adminQueryPath(ADMIN_ROUTES.auditLogs, {
    actorId: filters.actorId,
    action: filters.action,
    targetType: filters.targetType,
    targetId: filters.targetId,
    createdFrom: filters.createdFrom,
    createdTo: filters.createdTo,
    cursor,
    limit: ADMIN_PAGE_LIMIT,
  })
}

export async function fetchAdminAuditLogs(
  filters: AdminAuditFilters,
  cursor?: string,
): Promise<AdminAuditLogPage> {
  return AdminAuditLogPageSchema.parse(await apiRequest(adminAuditPath(filters, cursor)))
}

// ---------------------------------------------------------------------------
// 治理写（delist / restore / restrict-publish / ban / lift-restriction）
// ---------------------------------------------------------------------------

/**
 * 治理端点没有幂等键：并发确定性靠服务端条件更新（后到者 409 `GOVERNANCE_CONFLICT`）。
 * 客户端职责是「pending 时禁用提交」+ 失败如实透传，不假装成功。
 */
async function submitGovernance(
  path: string,
  body:
    | GovernanceListingDelistInput
    | GovernanceListingRestoreInput
    | GovernanceRestrictInput
    | GovernanceLiftRestrictionInput,
): Promise<GovernanceResult> {
  return GovernanceResultSchema.parse(
    await apiRequest(path, { body: JSON.stringify(body), method: 'POST' }),
  )
}

export function delistListing(
  listingId: string,
  input: GovernanceListingDelistInput,
): Promise<GovernanceResult> {
  return submitGovernance(ADMIN_ROUTES.listingDelist(listingId), input)
}

export function restoreListing(
  listingId: string,
  input: GovernanceListingRestoreInput,
): Promise<GovernanceResult> {
  return submitGovernance(ADMIN_ROUTES.listingRestore(listingId), input)
}

export function restrictUserPublish(
  userId: string,
  input: GovernanceRestrictInput,
): Promise<GovernanceResult> {
  return submitGovernance(ADMIN_ROUTES.userRestrictPublish(userId), input)
}

export function banUser(userId: string, input: GovernanceRestrictInput): Promise<GovernanceResult> {
  return submitGovernance(ADMIN_ROUTES.userBan(userId), input)
}

export function liftUserRestriction(
  userId: string,
  input: GovernanceLiftRestrictionInput,
): Promise<GovernanceResult> {
  return submitGovernance(ADMIN_ROUTES.userLiftRestriction(userId), input)
}
