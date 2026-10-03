import type { UseMutationResult } from '@tanstack/react-query'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { currentSessionGeneration } from '../../lib/session-cache'
import type { FavoriteWriteResult } from './api'
import { fetchFavoriteState, fetchMyFavorites, requestFavorite, requestUnfavorite } from './api'

export const favoritesKeys = {
  all: () => ['pc', 'favorites'] as const,
  list: () => [...favoritesKeys.all(), 'list'] as const,
  total: () => [...favoritesKeys.all(), 'total'] as const,
  state: (listingId: string) => [...favoritesKeys.all(), 'state', listingId] as const,
}

/** 我的收藏列表：游标分页，`nextCursor !== null` 即还有下一页。staleTime 0——进页就要看到最新状态。 */
export function useMyFavorites(ownerId: string) {
  return useInfiniteQuery({
    queryKey: favoritesKeys.list(),
    queryFn: ({ pageParam }) => fetchMyFavorites({ limit: 20, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: ownerId !== '',
    staleTime: 0,
  })
}

/**
 * 收藏总数：与列表同源，取 `GET /me/favorites` 的全量 `total`（limit=1 只要计数）。
 * 读不到时调用方显示未知而非 0——不用 profileStats，也不另开 count 端点。
 */
export function useFavoritesTotal(ownerId: string) {
  return useQuery({
    queryKey: favoritesKeys.total(),
    queryFn: () => fetchMyFavorites({ limit: 1 }),
    enabled: ownerId !== '',
    select: (data) => data.total,
    staleTime: 0,
  })
}

/**
 * 某商品的收藏态。失败收口成 outcome（不抛错）：`notFound` 降级「不可收藏」，
 * `failed` 保留重试——两种都不能让按钮假装成未收藏可点。
 */
export function useFavoriteState(listingId: string, viewerId: string | null) {
  return useQuery({
    queryKey: favoritesKeys.state(listingId),
    queryFn: () => fetchFavoriteState(listingId),
    enabled: viewerId !== null,
    staleTime: 0,
  })
}

type SessionMutationContext = { generation: number }

function captureSession(): SessionMutationContext {
  return { generation: currentSessionGeneration() }
}

function isSessionCurrent(context: SessionMutationContext | undefined): boolean {
  return context !== undefined && context.generation === currentSessionGeneration()
}

/** 写成功后以服务端结论更新缓存：state 直接写结果，列表与计数失效重拉（不本地增删行）。 */
function applyFavoriteWrite(
  queryClient: ReturnType<typeof useQueryClient>,
  listingId: string,
  favorited: boolean,
): void {
  queryClient.setQueryData(favoritesKeys.state(listingId), {
    kind: 'loaded',
    favorited,
  } satisfies FavoriteState)
  void queryClient.invalidateQueries({ queryKey: favoritesKeys.list() })
  void queryClient.invalidateQueries({ queryKey: favoritesKeys.total() })
}

type FavoriteState = { kind: 'loaded'; favorited: boolean }

function useFavoriteWriteMutation(
  request: (listingId: string) => Promise<FavoriteWriteResult>,
): UseMutationResult<FavoriteWriteResult, Error, string, SessionMutationContext> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (listingId: string) => request(listingId),
    onMutate: captureSession,
    onSuccess: (result, listingId, context) => {
      if (!isSessionCurrent(context)) return
      if (result.kind === 'written') applyFavoriteWrite(queryClient, listingId, result.favorited)
    },
  })
}

/** 收藏（POST，仅对在售商品可用；幂等）。失败以 `result.kind === 'failed'` 回来，不抛错。 */
export function useFavoriteMutation(): UseMutationResult<
  FavoriteWriteResult,
  Error,
  string,
  SessionMutationContext
> {
  return useFavoriteWriteMutation(requestFavorite)
}

/** 取消收藏（DELETE，无条件幂等——失效条目也能取消）。 */
export function useUnfavoriteMutation(): UseMutationResult<
  FavoriteWriteResult,
  Error,
  string,
  SessionMutationContext
> {
  return useFavoriteWriteMutation(requestUnfavorite)
}
