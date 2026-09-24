import type {
  AdminAuditLogPage,
  AdminListingDetail,
  AdminListingSummaryPage,
  AdminMeResponse,
  AdminModerationDetail,
  AdminModerationQueue,
  AdminOverview,
  AdminTransactionPage,
  AdminUserDetail,
  AdminUserSummaryPage,
} from '@fish/contracts/admin/schema'
import {
  AdminAuditLogPageSchema,
  AdminListingDetailSchema,
  AdminListingSummaryPageSchema,
  AdminMeResponseSchema,
  AdminModerationDetailSchema,
  AdminModerationQueueSchema,
  AdminOverviewSchema,
  AdminTransactionPageSchema,
  AdminUserDetailSchema,
  AdminUserSummaryPageSchema,
} from '@fish/contracts/admin/schema'
import type { GovernanceResult } from '@fish/contracts/governance/schema'
import { GovernanceResultSchema } from '@fish/contracts/governance/schema'
import type { ModerationDecisionInput } from '@fish/contracts/moderation/schema'
import type { AdminReportDetail, AdminReportHandleInput } from '@fish/contracts/reports/schema'
import {
  AdminReportDetailSchema,
  AdminReportListResponseSchema,
} from '@fish/contracts/reports/schema'
import { apiRequest } from '../../lib/api-client'

/**
 * Admin 后台数据入口（#73 设计 §7）：全部走真实 `/admin/*` API，相对路径由
 * `lib/api-client` 拼成 `/api/...`（Vite 代理去前缀）。前端不硬编码敏感词 / 审核规则。
 *
 * 返回类型一律取 `@fish/contracts/**` 并用同一个 schema 在运行时校验
 * （与 `features/chat/api.ts` 同口径）：契约改名 / 改字段会让这里直接编译失败或解析报错，
 * 而不是静默漂移。举报（#73）的 DTO 单独放在 `@fish/contracts/reports/schema`：
 * 它既是用户端契约也是 Admin 契约，塞进 admin/schema 会让用户端也依赖 Admin 域。
 */

export type AdminListQuery = {
  q?: string
  authStatus?: string
  role?: string
  cursor?: string
  limit?: number
}

export type AdminListingsQuery = {
  q?: string
  status?: string
  sellerId?: string
  createdFrom?: string
  createdTo?: string
  cursor?: string
  limit?: number
}

export type AdminAuditLogsQuery = {
  actorId?: string
  action?: string
  targetType?: string
  targetId?: string
  createdFrom?: string
  createdTo?: string
  cursor?: string
  limit?: number
}

export type AdminModerationQueueQuery = { cursor?: string; limit?: number }
export type AdminReportsQuery = {
  status?: string
  targetType?: string
  reason?: string
  cursor?: string
  limit?: number
}
export type AdminTransactionsQuery = {
  q?: string
  status?: string
  buyerId?: string
  sellerId?: string
  listingId?: string
  createdFrom?: string
  createdTo?: string
  cursor?: string
  limit?: number
}

function queryString(query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value))
  }
  const str = params.toString()
  return str ? `?${str}` : ''
}

export async function fetchAdminMe(): Promise<AdminMeResponse> {
  return AdminMeResponseSchema.parse(await apiRequest('/admin/me'))
}

export async function fetchAdminOverview(): Promise<AdminOverview> {
  return AdminOverviewSchema.parse(await apiRequest('/admin/overview'))
}

export async function fetchAdminUsers(query: AdminListQuery): Promise<AdminUserSummaryPage> {
  return AdminUserSummaryPageSchema.parse(await apiRequest(`/admin/users${queryString(query)}`))
}

export async function fetchAdminUser(userId: string): Promise<AdminUserDetail> {
  return AdminUserDetailSchema.parse(await apiRequest(`/admin/users/${userId}`))
}

export async function fetchAdminListings(
  query: AdminListingsQuery,
): Promise<AdminListingSummaryPage> {
  return AdminListingSummaryPageSchema.parse(
    await apiRequest(`/admin/listings${queryString(query)}`),
  )
}

export async function fetchAdminListing(listingId: string): Promise<AdminListingDetail> {
  return AdminListingDetailSchema.parse(await apiRequest(`/admin/listings/${listingId}`))
}

export async function fetchAdminAuditLogs(query: AdminAuditLogsQuery): Promise<AdminAuditLogPage> {
  return AdminAuditLogPageSchema.parse(await apiRequest(`/admin/audit-logs${queryString(query)}`))
}

export async function fetchAdminModerationQueue(
  query: AdminModerationQueueQuery,
): Promise<AdminModerationQueue> {
  return AdminModerationQueueSchema.parse(
    await apiRequest(`/admin/moderation/queue${queryString(query)}`),
  )
}

export async function fetchAdminModerationDetail(recordId: string): Promise<AdminModerationDetail> {
  return AdminModerationDetailSchema.parse(await apiRequest(`/admin/moderation/${recordId}`))
}

export async function fetchAdminReports(
  query: AdminReportsQuery,
): Promise<ReturnType<typeof AdminReportListResponseSchema.parse>> {
  return AdminReportListResponseSchema.parse(
    await apiRequest(`/admin/reports${queryString(query)}`),
  )
}

export async function fetchAdminReport(reportId: string): Promise<AdminReportDetail> {
  return AdminReportDetailSchema.parse(await apiRequest(`/admin/reports/${reportId}`))
}

/** 处理举报（#73）：只写结果与原因；治理动作另有入口，不在本函数内。 */
export async function handleAdminReport(
  reportId: string,
  input: AdminReportHandleInput,
): Promise<void> {
  await apiRequest(`/admin/reports/${reportId}/handle`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function decideAdminModeration(
  recordId: string,
  input: ModerationDecisionInput,
  requestId: string,
): Promise<AdminModerationDetail> {
  return AdminModerationDetailSchema.parse(
    await apiRequest(`/admin/moderation/${recordId}/decision`, {
      method: 'POST',
      headers: { 'Idempotency-Key': requestId },
      body: JSON.stringify(input),
    }),
  )
}

/**
 * 治理动作（#73 治理半场 PR3）。五个端点形状一致：`{ reason, sourceReportId?, expiresAt? }`，
 * 返回 `GovernanceResult`（动作 + 目标 + 最新状态 / 限制快照）。
 *
 * 与处理举报分开（grill Q9）：这里动商品或用户的真实状态，审计与业务同事务写入。
 * 失败态由 `apiRequest` 抛 `ApiError`，调用方按 `error.code` 分支：
 * `GOVERNANCE_CONFLICT`（其他管理员刚做过）必须让用户看到而不是静默重试。
 */
export type GovernanceActionInput = {
  reason: string
  sourceReportId?: string
  expiresAt?: string
}

async function postGovernanceAction(
  path: string,
  input: GovernanceActionInput,
): Promise<GovernanceResult> {
  return GovernanceResultSchema.parse(
    await apiRequest(path, { method: 'POST', body: JSON.stringify(input) }),
  )
}

/** POST /admin/listings/:id/delist —— 商品下架（卖家随后不能 PATCH / 上架）。 */
export function delistAdminListing(
  listingId: string,
  input: GovernanceActionInput,
): Promise<GovernanceResult> {
  return postGovernanceAction(`/admin/listings/${listingId}/delist`, input)
}

/** POST /admin/listings/:id/restore —— 恢复商品到 delist 审计快照里的 prior_listing_status。 */
export function restoreAdminListing(
  listingId: string,
  input: GovernanceActionInput,
): Promise<GovernanceResult> {
  return postGovernanceAction(`/admin/listings/${listingId}/restore`, input)
}

/** POST /admin/users/:id/restrict-publish —— 限制发布（PUBLISH_RESTRICT）。 */
export function restrictAdminUserPublish(
  userId: string,
  input: GovernanceActionInput,
): Promise<GovernanceResult> {
  return postGovernanceAction(`/admin/users/${userId}/restrict-publish`, input)
}

/** POST /admin/users/:id/ban —— 封禁（BAN，只禁写不禁读）。 */
export function banAdminUser(
  userId: string,
  input: GovernanceActionInput,
): Promise<GovernanceResult> {
  return postGovernanceAction(`/admin/users/${userId}/ban`, input)
}

/** POST /admin/users/:id/lift-restriction —— 解除该用户全部生效中的限制。 */
export function liftAdminUserRestriction(
  userId: string,
  input: GovernanceActionInput,
): Promise<GovernanceResult> {
  return postGovernanceAction(`/admin/users/${userId}/lift-restriction`, input)
}

export async function fetchAdminTransactions(
  query: AdminTransactionsQuery,
): Promise<AdminTransactionPage> {
  return AdminTransactionPageSchema.parse(
    await apiRequest(`/admin/transactions${queryString(query)}`),
  )
}
