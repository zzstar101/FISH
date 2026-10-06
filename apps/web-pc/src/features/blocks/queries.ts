import type { UseMutationResult } from '@tanstack/react-query'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { currentSessionGeneration } from '../../lib/session-cache'
import type { BlockStateOutcome, BlockWriteResult } from './api'
import {
  BLOCKS_PAGE_LIMIT,
  fetchBlockState,
  fetchMyBlocks,
  requestBlock,
  requestUnblock,
} from './api'

/**
 * 拉黑域查询与变更（#466）。queryKey 一律 `['pc','blocks',…]`：切号时
 * `resetPcSession` 按 `['pc']` 前缀整命名空间清理，不把 A 的黑名单留给 B。
 */

export const blocksKeys = {
  all: () => ['pc', 'blocks'] as const,
  list: () => [...blocksKeys.all(), 'list'] as const,
  state: (userId: string) => [...blocksKeys.all(), 'state', userId] as const,
}

/** 我的黑名单：游标分页，`nextCursor !== null` 即还有下一页。staleTime 0——进页看最新。 */
export function useMyBlocks(ownerId: string) {
  return useInfiniteQuery({
    queryKey: blocksKeys.list(),
    queryFn: ({ pageParam }) =>
      fetchMyBlocks({ limit: BLOCKS_PAGE_LIMIT, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: ownerId !== '',
    staleTime: 0,
  })
}

/**
 * 与某人的拉黑状态。失败收口成 outcome（不抛错）：`notFound` 降级「无法拉黑」，
 * `failed` 保留重试——两种都不能让按钮假装成未拉黑可点。
 */
export function useBlockState(userId: string) {
  return useQuery({
    queryKey: blocksKeys.state(userId),
    queryFn: () => fetchBlockState(userId),
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
function applyBlockWrite(
  queryClient: ReturnType<typeof useQueryClient>,
  userId: string,
  result: Extract<BlockWriteResult, { kind: 'written' }>,
): void {
  queryClient.setQueryData(blocksKeys.state(userId), {
    kind: 'loaded',
    blocked: result.blocked,
  } satisfies BlockStateOutcome)
  void queryClient.invalidateQueries({ queryKey: blocksKeys.list() })
}

/** 拉黑 / 解除共用的写路径：同一个「以服务端结论更新缓存」的收口。 */
function useBlockWriteMutation(
  userId: string,
  request: (userId: string) => Promise<BlockWriteResult>,
): UseMutationResult<BlockWriteResult, Error, void, SessionMutationContext> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => request(userId),
    onMutate: captureSession,
    onSuccess: (result, _variables, context) => {
      if (!isSessionCurrent(context)) return
      if (result.kind === 'written') applyBlockWrite(queryClient, userId, result)
    },
  })
}

export function useBlockUser(
  userId: string,
): UseMutationResult<BlockWriteResult, Error, void, SessionMutationContext> {
  return useBlockWriteMutation(userId, requestBlock)
}

export function useUnblockUser(
  userId: string,
): UseMutationResult<BlockWriteResult, Error, void, SessionMutationContext> {
  return useBlockWriteMutation(userId, requestUnblock)
}
