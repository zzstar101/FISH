import type { UseMutationResult } from '@tanstack/react-query'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { currentSessionGeneration } from '../../lib/session-cache'
import type { FollowStateOutcome, FollowWriteResult } from './api'
import { fetchFollowState, fetchMyFollowing, requestFollow, requestUnfollow } from './api'

export const followsKeys = {
  all: () => ['pc', 'follows'] as const,
  list: () => [...followsKeys.all(), 'list'] as const,
  state: (userId: string) => [...followsKeys.all(), 'state', userId] as const,
}

/** 我的关注列表：游标分页，`nextCursor !== null` 即还有下一页。staleTime 0——进页就要看到最新状态。 */
export function useMyFollowing(ownerId: string) {
  return useInfiniteQuery({
    queryKey: followsKeys.list(),
    queryFn: ({ pageParam }) => fetchMyFollowing({ limit: 20, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: ownerId !== '',
    staleTime: 0,
  })
}

/**
 * 与某人的关注状态。失败收口成 outcome（不抛错）：`notFound` 降级「无法关注」，
 * `failed` 保留重试——两种都不能让按钮假装成未关注可点。
 */
export function useFollowState(userId: string, enabled: boolean) {
  return useQuery({
    queryKey: followsKeys.state(userId),
    queryFn: () => fetchFollowState(userId),
    enabled,
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

/** 写成功后以服务端结论更新缓存：state 直接写结果，列表失效重拉（不本地增删行）。 */
function applyFollowWrite(
  queryClient: ReturnType<typeof useQueryClient>,
  userId: string,
  result: Extract<FollowWriteResult, { kind: 'written' }>,
): void {
  queryClient.setQueryData(followsKeys.state(userId), {
    kind: 'loaded',
    following: result.following,
    mutual: result.mutual,
  } satisfies FollowStateOutcome)
  void queryClient.invalidateQueries({ queryKey: followsKeys.list() })
}

function useFollowWriteMutation(
  request: (userId: string) => Promise<FollowWriteResult>,
): UseMutationResult<FollowWriteResult, Error, string, SessionMutationContext> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (userId: string) => request(userId),
    onMutate: captureSession,
    onSuccess: (result, userId, context) => {
      if (!isSessionCurrent(context)) return
      if (result.kind === 'written') {
        applyFollowWrite(queryClient, userId, result)
      }
    },
  })
}

/** 关注（POST，幂等）。失败以 `result.kind === 'failed'` 回来，不抛错。 */
export function useFollowMutation(): UseMutationResult<
  FollowWriteResult,
  Error,
  string,
  SessionMutationContext
> {
  return useFollowWriteMutation(requestFollow)
}

/** 取消关注（DELETE，幂等）。 */
export function useUnfollowMutation(): UseMutationResult<
  FollowWriteResult,
  Error,
  string,
  SessionMutationContext
> {
  return useFollowWriteMutation(requestUnfollow)
}
