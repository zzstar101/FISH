import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchMyFeedback, submitFeedback } from './api'

export const feedbackKeys = {
  mine: ['pc', 'feedback', 'mine'] as const,
}

/** 提交反馈。成功（含幂等重放）后刷新「我的反馈」。 */
export function useSubmitFeedback() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: submitFeedback,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: feedbackKeys.mine })
    },
  })
}

/** 「我的反馈」列表（游标分页）。页面落在 RequireAuth 分支内，调用方仍显式给 `enabled`。 */
export function useMyFeedback(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: feedbackKeys.mine,
    queryFn: ({ pageParam }) => fetchMyFeedback(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled,
    staleTime: 30_000,
  })
}
