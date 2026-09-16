import type { AdminMeResponse } from '@fish/contracts/admin/schema'
import { apiRequest } from '../../lib/api-client'

/**
 * Admin 后台数据入口（#73 设计 §7）：全部走真实 `/admin/*` API，相对路径由
 * `lib/api-client` 拼成 `/api/...`（Vite 代理去掉前缀）。前端不硬编码敏感词 / 审核规则。
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
  return (await apiRequest('/admin/me')) as AdminMeResponse
}

export async function fetchAdminOverview(): Promise<unknown> {
  return apiRequest('/admin/overview')
}

export async function fetchAdminUsers(query: AdminListQuery): Promise<unknown> {
  return apiRequest(`/admin/users${queryString(query)}`)
}

export async function fetchAdminUser(userId: string): Promise<unknown> {
  return apiRequest(`/admin/users/${userId}`)
}

export async function fetchAdminListings(query: AdminListingsQuery): Promise<unknown> {
  return apiRequest(`/admin/listings${queryString(query)}`)
}

export async function fetchAdminListing(listingId: string): Promise<unknown> {
  return apiRequest(`/admin/listings/${listingId}`)
}

export async function fetchAdminAuditLogs(query: AdminAuditLogsQuery): Promise<unknown> {
  return apiRequest(`/admin/audit-logs${queryString(query)}`)
}
