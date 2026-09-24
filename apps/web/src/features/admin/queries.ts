import type { AdminMeResponse } from '@fish/contracts/admin/schema'
import type { ModerationDecisionInput } from '@fish/contracts/moderation/schema'
import type { AdminReportHandleInput } from '@fish/contracts/reports/schema'
import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { ApiError } from '../../lib/api-client'
import {
  type AdminAuditLogsQuery,
  type AdminListingsQuery,
  type AdminListQuery,
  type AdminModerationQueueQuery,
  type AdminReportsQuery,
  type AdminTransactionsQuery,
  banAdminUser,
  decideAdminModeration,
  delistAdminListing,
  fetchAdminAuditLogs,
  fetchAdminListing,
  fetchAdminListings,
  fetchAdminMe,
  fetchAdminModerationDetail,
  fetchAdminModerationQueue,
  fetchAdminOverview,
  fetchAdminReport,
  fetchAdminReports,
  fetchAdminTransactions,
  fetchAdminUser,
  fetchAdminUsers,
  type GovernanceActionInput,
  handleAdminReport,
  liftAdminUserRestriction,
  restoreAdminListing,
  restrictAdminUserPublish,
} from './api'

/**
 * Admin 数据 hook（#73 设计 §7）：所有列表统一游标分页；筛选条件写入 URL，
 * 便于复制定位（页面路由层用 `search` 承载，见各页面）。
 */

export const adminKeys = {
  /** 所有 admin 查询的公共前缀（供跨账号缓存清理用，见 `clearAdminQueries`）。 */
  root: ['admin'] as const,
  me: () => ['admin', 'me'] as const,
  overview: () => ['admin', 'overview'] as const,
  users: (query: AdminListQuery) => ['admin', 'users', query] as const,
  user: (userId: string) => ['admin', 'user', userId] as const,
  listings: (query: AdminListingsQuery) => ['admin', 'listings', query] as const,
  listing: (listingId: string) => ['admin', 'listing', listingId] as const,
  auditLogs: (query: AdminAuditLogsQuery) => ['admin', 'audit-logs', query] as const,
  moderationQueue: (query: AdminModerationQueueQuery) =>
    ['admin', 'moderation-queue', query] as const,
  moderationDetail: (recordId: string) => ['admin', 'moderation', recordId] as const,
  reports: (query: AdminReportsQuery) => ['admin', 'reports', query] as const,
  report: (reportId: string) => ['admin', 'report', reportId] as const,
  transactions: (query: AdminTransactionsQuery) => ['admin', 'transactions', query] as const,
}

/**
 * 清空全部 Admin 查询缓存（评审 P1 修复）。
 *
 * Admin query key 与用户身份无关，而 `useAdminMe()` 有 `staleTime`；若登出 / 换号后
 * 不清理，下一个账号打开 `/admin` 可能直接命中前一个管理员仍 fresh 的缓存，
 * 造成跨账号的后台数据泄露窗口。在身份变化时调用本函数即可。
 */
export function clearAdminQueries(queryClient: Pick<QueryClient, 'removeQueries'>): void {
  queryClient.removeQueries({ queryKey: adminKeys.root })
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

export function useAdminModerationQueue(query: AdminModerationQueueQuery) {
  return useQuery({
    queryKey: adminKeys.moderationQueue(query),
    queryFn: () => fetchAdminModerationQueue(query),
  })
}

export function useAdminModerationDetail(recordId: string) {
  return useQuery({
    queryKey: adminKeys.moderationDetail(recordId),
    queryFn: () => fetchAdminModerationDetail(recordId),
    enabled: Boolean(recordId),
  })
}

export function useAdminReports(query: AdminReportsQuery) {
  return useQuery({
    queryKey: adminKeys.reports(query),
    queryFn: () => fetchAdminReports(query),
  })
}

export function useAdminReport(reportId: string) {
  return useQuery({
    queryKey: adminKeys.report(reportId),
    queryFn: () => fetchAdminReport(reportId),
    enabled: Boolean(reportId),
  })
}

/**
 * 处理举报（#73）：成功 / 失败都刷新队列与详情。
 *
 * 失败也要刷新是故意的——409 REPORT_CONFLICT 说明另一个管理员刚处理了同一条，
 * 此时队列和详情的旧缓存都是过期的，让界面立刻显示真实状态，而不是让操作者
 * 看着一张已失效的表单反复提交。
 */
export function useHandleAdminReport(reportId: string) {
  const queryClient = useQueryClient()
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'reports'] })
    void queryClient.invalidateQueries({ queryKey: ['admin', 'report'] })
    void queryClient.invalidateQueries({ queryKey: adminKeys.auditLogs({}) })
  }
  return useMutation({
    mutationFn: (input: AdminReportHandleInput) => handleAdminReport(reportId, input),
    onError: invalidate,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.report(reportId) })
      invalidate()
    },
  })
}

export function useAdminTransactions(query: AdminTransactionsQuery) {
  return useQuery({
    queryKey: adminKeys.transactions(query),
    queryFn: () => fetchAdminTransactions(query),
  })
}

export function useDecideAdminModeration(recordId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ input, requestId }: { input: ModerationDecisionInput; requestId: string }) =>
      decideAdminModeration(recordId, input, requestId),
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.moderationDetail(recordId) })
      void queryClient.invalidateQueries({ queryKey: ['admin', 'moderation-queue'] })
    },
    onSuccess: (detail) => {
      queryClient.setQueryData(adminKeys.moderationDetail(recordId), detail)
      void queryClient.invalidateQueries({ queryKey: ['admin', 'moderation-queue'] })
      void queryClient.invalidateQueries({ queryKey: adminKeys.listing(detail.item.listing.id) })
      void queryClient.invalidateQueries({ queryKey: adminKeys.auditLogs({}) })
    },
  })
}

/**
 * 治理动作（#73 治理半场 PR3）：下架 / 恢复商品，限制发布 / 封禁 / 解除限制。
 *
 * 五个端点共用一个 mutation，区别只在 `action` 与目标 id；成功后统一 invalidate
 * 商品详情、用户详情、审计日志与 Overview——治理结果的落点就是这四处。
 *
 * 409 `GOVERNANCE_CONFLICT` 是**预期的正常分支**（另一个管理员刚做过同一动作），
 * 不是错误提示，调用方据此把按钮换成「已下架」这类真实状态。
 */
export type GovernanceAction =
  | 'delist-listing'
  | 'restore-listing'
  | 'restrict-publish'
  | 'ban'
  | 'lift-restriction'

export function useGovernanceAction() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      action,
      targetId,
      input,
    }: {
      action: GovernanceAction
      targetId: string
      input: GovernanceActionInput
    }) => {
      if (action === 'delist-listing') return delistAdminListing(targetId, input)
      if (action === 'restore-listing') return restoreAdminListing(targetId, input)
      if (action === 'restrict-publish') return restrictAdminUserPublish(targetId, input)
      if (action === 'ban') return banAdminUser(targetId, input)
      return liftAdminUserRestriction(targetId, input)
    },
    onSuccess: (_result, variables) => {
      // 用 mutation 参数而不是 `result.targetId`（评审 m5）：限制类动作的
      // `result.targetId` 是**限制记录 id**（审计目标），拿它 invalidate 用户详情只会
      // 命中一个永不存在的 key，用户详情一直停在旧状态。
      // `variables.targetId` 对商品动作是 listingId、对用户动作是 userId。
      if (variables.action === 'delist-listing' || variables.action === 'restore-listing') {
        void queryClient.invalidateQueries({ queryKey: adminKeys.listing(variables.targetId) })
        void queryClient.invalidateQueries({ queryKey: ['admin', 'listings'] })
      } else {
        void queryClient.invalidateQueries({ queryKey: adminKeys.user(variables.targetId) })
        void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })
      }
      void queryClient.invalidateQueries({ queryKey: adminKeys.auditLogs({}) })
      void queryClient.invalidateQueries({ queryKey: adminKeys.overview() })
    },
  })
}

export type { AdminMeResponse }
