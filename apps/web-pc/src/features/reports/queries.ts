import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchMyReports, submitReport } from './api'

export const reportKeys = {
  all: ['pc', 'reports'] as const,
  mine: ['pc', 'reports', 'mine'] as const,
}

/**
 * 提交举报。成功后刷新「我的举报」——重复举报（`created: false`）也刷新：
 * 那条未决单的进度可能已经变了，端上不能拿旧快照糊弄用户。
 */
export function useSubmitReport() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: submitReport,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: reportKeys.mine })
    },
  })
}

/**
 * 「我的举报」列表（游标分页）。
 *
 * `enabled` 由调用方按登录态给：本端点挂 `requireAuth`，匿名请求会拿到
 * `401 UNAUTHENTICATED` 并触发 `query-client.ts` 的全局跳登录 —— 在公开页面上
 * 被动发这种请求会把匿名访客挤出当前页。
 */
export function useMyReports(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: reportKeys.mine,
    queryFn: ({ pageParam }) => fetchMyReports(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled,
    staleTime: 30_000,
  })
}
