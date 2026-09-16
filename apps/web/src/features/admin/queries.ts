import type { AdminMeResponse } from '@fish/contracts/admin/schema'
import { queryOptions, useQuery } from '@tanstack/react-query'
import { ApiError } from '../../lib/api-client'
import {
  type AdminAuditLogsQuery,
  type AdminListingsQuery,
  type AdminListQuery,
  fetchAdminAuditLogs,
  fetchAdminListing,
  fetchAdminListings,
  fetchAdminMe,
  fetchAdminOverview,
  fetchAdminUser,
  fetchAdminUsers,
} from './api'

/**
 * Admin 数据 hook（#73 设计 §7）：所有列表统一游标分页；筛选条件写入 URL，
 * 便于复制定位（页面路由层用 `search` 承载，见各页面）。
 */

export const adminKeys = {
  me: () => ['admin', 'me'] as const,
  overview: () => ['admin', 'overview'] as const,
  users: (query: AdminListQuery) => ['admin', 'users', query] as const,
  user: (userId: string) => ['admin', 'user', userId] as const,
  listings: (query: AdminListingsQuery) => ['admin', 'listings', query] as const,
  listing: (listingId: string) => ['admin', 'listing', listingId] as const,
  auditLogs: (query: AdminAuditLogsQuery) => ['admin', 'audit-logs', query] as const,
}

/** 首页守卫数据：非 Admin 会抛 403 `FORBIDDEN`，由 AdminShell 统一转无权限页。 */
export const adminMeQueryOptions = () =>
  queryOptions({
    queryKey: adminKeys.me(),
    queryFn: fetchAdminMe,
    staleTime: 60_000,
  })

export function useAdminMe() {
  return useQuery(adminMeQueryOptions())
}

/** 已登录但非 Admin（403 FORBIDDEN）——AdminShell 用它区分「未登录」与「无权限」。 */
export function isForbiddenAdminError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403 && error.code === 'FORBIDDEN'
}

export function useAdminOverview() {
  return useQuery({ queryKey: adminKeys.overview(), queryFn: fetchAdminOverview })
}

export function useAdminUsers(query: AdminListQuery) {
  return useQuery({
    queryKey: adminKeys.users(query),
    queryFn: () => fetchAdminUsers(query),
  })
}

export function useAdminUser(userId: string) {
  return useQuery({
    queryKey: adminKeys.user(userId),
    queryFn: () => fetchAdminUser(userId),
    enabled: Boolean(userId),
  })
}

export function useAdminListings(query: AdminListingsQuery) {
  return useQuery({
    queryKey: adminKeys.listings(query),
    queryFn: () => fetchAdminListings(query),
  })
}

export function useAdminListing(listingId: string) {
  return useQuery({
    queryKey: adminKeys.listing(listingId),
    queryFn: () => fetchAdminListing(listingId),
    enabled: Boolean(listingId),
  })
}

export function useAdminAuditLogs(query: AdminAuditLogsQuery) {
  return useQuery({
    queryKey: adminKeys.auditLogs(query),
    queryFn: () => fetchAdminAuditLogs(query),
  })
}

export type { AdminMeResponse }
