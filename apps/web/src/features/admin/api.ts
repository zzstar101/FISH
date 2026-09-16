import type {
  AdminAuditLogPage,
  AdminListingDetail,
  AdminListingSummaryPage,
  AdminMeResponse,
  AdminOverview,
  AdminUserDetail,
  AdminUserSummaryPage,
} from '@fish/contracts/admin/schema'
import {
  AdminAuditLogPageSchema,
  AdminListingDetailSchema,
  AdminListingSummaryPageSchema,
  AdminMeResponseSchema,
  AdminOverviewSchema,
  AdminUserDetailSchema,
  AdminUserSummaryPageSchema,
} from '@fish/contracts/admin/schema'
import { apiRequest } from '../../lib/api-client'

/**
 * Admin 后台数据入口（#73 设计 §7）：全部走真实 `/admin/*` API，相对路径由
 * `lib/api-client` 拼成 `/api/...`（Vite 代理去前缀）。前端不硬编码敏感词 / 审核规则。
 *
 * 返回类型一律取 `@fish/contracts/admin/schema` 并用同一个 schema 在运行时校验
 * （与 `features/chat/api.ts` 同口径）：契约改名 / 改字段会让这里直接编译失败或解析报错，
 * 而不是静默漂移。
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
