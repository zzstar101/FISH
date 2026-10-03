import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { currentSessionGeneration } from '../../lib/session-cache'
import { clearMyViewHistory, fetchMyViewHistory } from './api'

/**
 * 缓存键带 `ownerId`（与 wish / chat / profile 同一口径）：换账号时即使漏了全局 reset，
 * 不同 owner 的键也不相等，读不到别人的缓存。`resetPcSession` 的 `['pc']` 全量清理
 * 仍是第一道防线，这里是第二道。
 */
export const viewHistoryKeys = {
  all: () => ['pc', 'view-history'] as const,
  list: (ownerId: string) => [...viewHistoryKeys.all(), 'list', ownerId] as const,
  total: (ownerId: string) => [...viewHistoryKeys.all(), 'total', ownerId] as const,
}

/**
 * 我的浏览记录：游标分页，`nextCursor !== null` 即还有下一页。
 * `staleTime: 0`——进页就要看到最新状态（刚看过的商品应立刻出现/顶新）。
 */
export function useMyViewHistory(ownerId: string) {
  return useInfiniteQuery({
    queryKey: viewHistoryKeys.list(ownerId),
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
    queryKey: viewHistoryKeys.total(ownerId),
    queryFn: () => fetchMyViewHistory({ limit: 1 }),
    enabled: ownerId !== '',
    select: (data) => data.total,
    staleTime: 0,
  })
}

type SessionMutationContext = { generation: number }

/**
 * 清空：成功后以服务端为准——列表与计数全部失效重拉（不本地清数组），
 * 失败由调用方展示文案，列表保持原样。会话代际守卫沿用 chat / wish 的 mutation 模式
 * （`captureSession` → `onSuccess` 里比对 `currentSessionGeneration()`）。
 */
export function useClearViewHistory() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => clearMyViewHistory(),
    onMutate: (): SessionMutationContext => ({ generation: currentSessionGeneration() }),
    onSuccess: (_result, _variables, context) => {
      if (context === undefined || context.generation !== currentSessionGeneration()) return
      void queryClient.invalidateQueries({ queryKey: viewHistoryKeys.all() })
    },
  })
}
