import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { currentSessionGeneration } from '../../lib/session-cache'
import { clearMyViewHistory, fetchMyViewHistory } from './api'

export const viewHistoryKeys = {
  all: () => ['pc', 'view-history'] as const,
  list: () => [...viewHistoryKeys.all(), 'list'] as const,
  total: () => [...viewHistoryKeys.all(), 'total'] as const,
}

/**
 * 我的浏览记录：游标分页，`nextCursor !== null` 即还有下一页。
 * `staleTime: 0`——进页就要看到最新状态（刚看过的商品应立刻出现/顶新）。
 */
export function useMyViewHistory(ownerId: string) {
  return useInfiniteQuery({
    queryKey: viewHistoryKeys.list(),
    queryFn: ({ pageParam }) => fetchMyViewHistory({ limit: 20, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: ownerId !== '',
    staleTime: 0,
  })
}

/**
 * 足迹总数：与列表同源，取 `GET /me/view-history` 的全量 `total`（limit=1 只要计数）。
 * 读不到时调用方显示未知而非 0（个人中心计数卡的先例：收藏 / 关注同款）。
 */
export function useViewHistoryTotal(ownerId: string) {
  return useQuery({
    queryKey: viewHistoryKeys.total(),
    queryFn: () => fetchMyViewHistory({ limit: 1 }),
    enabled: ownerId !== '',
    select: (data) => data.total,
    staleTime: 0,
  })
}

type SessionMutationContext = { generation: number }

/**
 * 清空：成功后以服务端为准——列表与计数全部失效重拉（不本地清数组），
 * 失败由调用方展示文案，列表保持原样。会话代际守卫沿用 favorites / follows 模式。
 */
export function useClearViewHistory() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => clearMyViewHistory(),
    onMutate: (): SessionMutationContext => ({ generation: currentSessionGeneration() }),
    onSuccess: (_result, _variables, context) => {
      if (context === undefined || context.generation !== currentSessionGeneration()) return
      void queryClient.invalidateQueries({ queryKey: viewHistoryKeys.list() })
      void queryClient.invalidateQueries({ queryKey: viewHistoryKeys.total() })
    },
  })
}
