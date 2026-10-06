import type { AdminDisputeResolveInput } from '@fish/contracts/disputes/schema'
import type {
  GovernanceLiftRestrictionInput,
  GovernanceListingDelistInput,
  GovernanceListingRestoreInput,
  GovernanceRestrictInput,
} from '@fish/contracts/governance/schema'
import type { ModerationDecisionInput } from '@fish/contracts/moderation/schema'
import type { AdminReportHandleInput } from '@fish/contracts/reports/schema'
import {
  type QueryClient,
  type UseMutationResult,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { currentSessionGeneration } from '../../lib/session-cache'
import type { AdminUsersFilters } from './admin-api'
import {
  type AdminAuditFilters,
  type AdminDisputesFilters,
  type AdminListingsFilters,
  type AdminModerationRecordsFilters,
  type AdminReportsFilters,
  type AdminTransactionsFilters,
  banUser,
  delistListing,
  fetchAdminAuditLogs,
  fetchAdminDisputeDetail,
  fetchAdminDisputes,
  fetchAdminListingDetail,
  fetchAdminListings,
  fetchAdminMe,
  fetchAdminMetrics,
  fetchAdminModerationDetail,
  fetchAdminModerationQueue,
  fetchAdminModerationRecords,
  fetchAdminOverview,
  fetchAdminReportDetail,
  fetchAdminReports,
  fetchAdminTransactions,
  fetchAdminUserDetail,
  fetchAdminUsers,
  liftUserRestriction,
  restoreListing,
  restrictUserPublish,
  submitDisputeResolve,
  submitModerationDecision,
  submitReportHandle,
} from './admin-api'

/**
 * Admin 域查询与变更（#467）。
 *
 * - queryKey 一律 `['pc','admin',…]`：首元素 `pc` 是 `resetPcSession` 的命名空间
 *   （lib/session-cache.ts），管理员切号 / 登出时整个后台缓存会被清掉，不会把
 *   A 管理员的数据闪现给 B。filters 对象进 key：TanStack 浅比较结构化克隆，
 *   对象字面量每次新建也不会破坏缓存命中（react-query 内置 structural sharing）。
 * - 列表全部 `useInfiniteQuery`（服务端游标分页），`staleTime: 0`：后台是多人
 *   同时操作的界面，进页即取新鲜值，不跨挂载复用旧页。
 * - 写操作成功后**整个 admin 命名空间失效**：一次治理动作会同时影响列表、详情、
 *   概览与审计四处展示，逐个枚举失效键容易漏，全量失效在后台这个数据量下没有代价。
 */

export const adminKeys = {
  all: () => ['pc', 'admin'] as const,
  me: () => [...adminKeys.all(), 'me'] as const,
  overview: () => [...adminKeys.all(), 'overview'] as const,
  metrics: (window: '24h' | '7d' | '30d') => [...adminKeys.all(), 'metrics', window] as const,
  users: (filters: AdminUsersFilters) => [...adminKeys.all(), 'users', filters] as const,
  userDetail: (userId: string) => [...adminKeys.all(), 'user', userId] as const,
  listings: (filters: AdminListingsFilters) => [...adminKeys.all(), 'listings', filters] as const,
  listingDetail: (listingId: string) => [...adminKeys.all(), 'listing', listingId] as const,
  moderationQueue: () => [...adminKeys.all(), 'moderation-queue'] as const,
  moderationRecords: (filters: AdminModerationRecordsFilters) =>
    [...adminKeys.all(), 'moderation-records', filters] as const,
  moderationDetail: (recordId: string) => [...adminKeys.all(), 'moderation', recordId] as const,
  reports: (filters: AdminReportsFilters) => [...adminKeys.all(), 'reports', filters] as const,
  reportDetail: (reportId: string) => [...adminKeys.all(), 'report', reportId] as const,
  disputes: (filters: AdminDisputesFilters) => [...adminKeys.all(), 'disputes', filters] as const,
  disputeDetail: (disputeId: string) => [...adminKeys.all(), 'dispute', disputeId] as const,
  transactions: (filters: AdminTransactionsFilters) =>
    [...adminKeys.all(), 'transactions', filters] as const,
  audit: (filters: AdminAuditFilters) => [...adminKeys.all(), 'audit', filters] as const,
}

// ---------------------------------------------------------------------------
// 只读查询
// ---------------------------------------------------------------------------

/**
 * `/admin/me`：既是管理壳的权限门（403 → 无权限页），也是用户侧导航「管理后台」
 * 入口的探针（普通用户 403，入口不渲染）。普通用户每次进站都会多这一个 403 请求，
 * 用 `staleTime` 压到会话级一次。`retry: false`：403 不是抖动，重试只会更吵。
 */
export function useAdminMe(enabled: boolean) {
  return useQuery({
    enabled,
    queryFn: fetchAdminMe,
    queryKey: adminKeys.me(),
    retry: false,
    staleTime: 5 * 60_000,
  })
}

export function useAdminOverview() {
  return useQuery({ queryFn: fetchAdminOverview, queryKey: adminKeys.overview(), staleTime: 0 })
}

export function useAdminMetrics(window: '24h' | '7d' | '30d') {
  return useQuery({
    queryFn: () => fetchAdminMetrics(window),
    queryKey: adminKeys.metrics(window),
    staleTime: 0,
  })
}

export function useAdminUsers(filters: AdminUsersFilters) {
  return useInfiniteQuery({
    queryKey: adminKeys.users(filters),
    queryFn: ({ pageParam }) => fetchAdminUsers(filters, pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 0,
  })
}

export function useAdminUserDetail(userId: string) {
  return useQuery({
    queryFn: () => fetchAdminUserDetail(userId),
    queryKey: adminKeys.userDetail(userId),
    staleTime: 0,
  })
}

export function useAdminListings(filters: AdminListingsFilters) {
  return useInfiniteQuery({
    queryKey: adminKeys.listings(filters),
    queryFn: ({ pageParam }) => fetchAdminListings(filters, pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 0,
  })
}

export function useAdminListingDetail(listingId: string) {
  return useQuery({
    queryFn: () => fetchAdminListingDetail(listingId),
    queryKey: adminKeys.listingDetail(listingId),
    staleTime: 0,
  })
}

export function useAdminModerationQueue() {
  return useInfiniteQuery({
    queryKey: adminKeys.moderationQueue(),
    queryFn: ({ pageParam }) => fetchAdminModerationQueue(pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 0,
  })
}

export function useAdminModerationRecords(filters: AdminModerationRecordsFilters) {
  return useInfiniteQuery({
    queryKey: adminKeys.moderationRecords(filters),
    queryFn: ({ pageParam }) => fetchAdminModerationRecords(filters, pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 0,
  })
}

export function useAdminModerationDetail(recordId: string) {
  return useQuery({
    queryFn: () => fetchAdminModerationDetail(recordId),
    queryKey: adminKeys.moderationDetail(recordId),
    staleTime: 0,
  })
}

export function useAdminReports(filters: AdminReportsFilters) {
  return useInfiniteQuery({
    queryKey: adminKeys.reports(filters),
    queryFn: ({ pageParam }) => fetchAdminReports(filters, pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 0,
  })
}

export function useAdminReportDetail(reportId: string) {
  return useQuery({
    queryFn: () => fetchAdminReportDetail(reportId),
    queryKey: adminKeys.reportDetail(reportId),
    staleTime: 0,
  })
}

export function useAdminDisputes(filters: AdminDisputesFilters) {
  return useInfiniteQuery({
    queryKey: adminKeys.disputes(filters),
    queryFn: ({ pageParam }) => fetchAdminDisputes(filters, pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 0,
  })
}

export function useAdminDisputeDetail(disputeId: string) {
  return useQuery({
    queryFn: () => fetchAdminDisputeDetail(disputeId),
    queryKey: adminKeys.disputeDetail(disputeId),
    staleTime: 0,
  })
}

export function useAdminTransactions(filters: AdminTransactionsFilters) {
  return useInfiniteQuery({
    queryKey: adminKeys.transactions(filters),
    queryFn: ({ pageParam }) => fetchAdminTransactions(filters, pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 0,
  })
}

export function useAdminAuditLogs(filters: AdminAuditFilters) {
  return useInfiniteQuery({
    queryKey: adminKeys.audit(filters),
    queryFn: ({ pageParam }) => fetchAdminAuditLogs(filters, pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 0,
  })
}

// ---------------------------------------------------------------------------
// 写操作
// ---------------------------------------------------------------------------

/**
 * 会话代际守卫：onMutate 捕获代际，成功/失败回调里比对，跨代际（已切号）不失效缓存
 * ——迟到的旧代际失效会把 B 会话刚拉到的数据标记成脏并立刻重取，徒增请求还可能闪旧数据。
 */
function useAdminMutation<TInput, TResult>(
  mutationFn: (input: TInput) => Promise<TResult>,
): UseMutationResult<TResult, Error, TInput, number> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn,
    onMutate: () => currentSessionGeneration(),
    onError: (_error, _input, generation) => {
      if (generation === currentSessionGeneration()) invalidateAdmin(queryClient)
    },
    onSuccess: (_result, _input, generation) => {
      if (generation === currentSessionGeneration()) invalidateAdmin(queryClient)
    },
  })
}

/** 全量失效 admin 命名空间（见文件头注释：写操作影响面横跨列表/详情/概览/审计）。 */
function invalidateAdmin(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: adminKeys.all() })
}

export function useModerationDecision(recordId: string) {
  return useAdminMutation(
    ({ input, idempotencyKey }: { input: ModerationDecisionInput; idempotencyKey: string }) =>
      submitModerationDecision(recordId, input, idempotencyKey),
  )
}

export function useReportHandle(reportId: string) {
  return useAdminMutation((input: AdminReportHandleInput) => submitReportHandle(reportId, input))
}

export function useDisputeResolve(disputeId: string) {
  return useAdminMutation((input: AdminDisputeResolveInput) =>
    submitDisputeResolve(disputeId, input),
  )
}

export function useListingDelist(listingId: string) {
  return useAdminMutation((input: GovernanceListingDelistInput) => delistListing(listingId, input))
}

export function useListingRestore(listingId: string) {
  return useAdminMutation((input: GovernanceListingRestoreInput) =>
    restoreListing(listingId, input),
  )
}

export function useUserRestrictPublish(userId: string) {
  return useAdminMutation((input: GovernanceRestrictInput) => restrictUserPublish(userId, input))
}

export function useUserBan(userId: string) {
  return useAdminMutation((input: GovernanceRestrictInput) => banUser(userId, input))
}

export function useUserLiftRestriction(userId: string) {
  return useAdminMutation((input: GovernanceLiftRestrictionInput) =>
    liftUserRestriction(userId, input),
  )
}
