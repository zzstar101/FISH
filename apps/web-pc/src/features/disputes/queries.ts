import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError } from '../../lib/api-client'
import { currentSessionGeneration } from '../../lib/session-cache'
import {
  addDisputeEvidence,
  type DisputeConversation,
  fetchDispute,
  fetchDisputeConversation,
  fetchMyDisputes,
  startDispute,
  uploadDisputeAttachment,
  withdrawDispute,
} from './api'

export const disputeKeys = {
  all: ['pc', 'disputes'] as const,
  mine: ['pc', 'disputes', 'mine'] as const,
  detail: (disputeId: string) => ['pc', 'disputes', 'detail', disputeId] as const,
  conversation: (transactionId: string) =>
    ['pc', 'disputes', 'conversation', transactionId] as const,
}

const DISPUTE_DETAIL_STALE_MS = 15_000

/**
 * 「我的争议」列表（游标分页）。
 *
 * `enabled` 由调用方按登录态给：本端点挂 `requireAuth`，匿名请求会拿到
 * `401 UNAUTHENTICATED` 并触发 `query-client.ts` 的全局跳登录（同 `useMyReports`）。
 *
 * 争议状态会被对端撤回 / 管理员处理改变，所以回窗口时重取（全局默认关闭）。
 */
export function useMyDisputes(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: disputeKeys.mine,
    queryFn: ({ pageParam }) => fetchMyDisputes(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  })
}

/**
 * 详情：签名附件 URL（900s）与管理员处理结果都会在页面挂起期间变化。
 * - 回窗口立即重取（全局默认关闭）；
 * - 挂载期间 60s 轮询，保证结论与附件地址不会被旧缓存拖过签名有效期。
 */
export function useDispute(disputeId: string) {
  return useQuery({
    queryKey: disputeKeys.detail(disputeId),
    queryFn: () => fetchDispute(disputeId),
    staleTime: DISPUTE_DETAIL_STALE_MS,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  })
}

/**
 * 发起争议。成功后**只失效**相关查询（多一次请求换一致性）：
 * 并发提交 / 会话切换时，迟到的旧响应不能把旧账号的详情写回缓存，
 * 所以写缓存前先校验会话代际（同 `profile/queries.ts` 的 mutation 纪律）。
 */
export function useStartDispute() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: startDispute,
    onMutate: () => currentSessionGeneration(),
    onSuccess: (result, _variables, generation) => {
      if (generation !== currentSessionGeneration()) return
      void queryClient.invalidateQueries({ queryKey: disputeKeys.detail(result.dispute.id) })
      void queryClient.invalidateQueries({ queryKey: disputeKeys.mine })
    },
  })
}

/**
 * 撤回：成功后让详情与列表失效。
 *
 * 并发失败（对端先被管理员处理 / 另一标签页已撤回）时服务端回 409，
 * 此时本地详情已经是陈旧状态：直接失效让页面重取到终态，而不是让用户对着
 * 「处理中」的旧页面反复点撤回。
 */
export function useWithdrawDispute(disputeId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => withdrawDispute(disputeId),
    onMutate: () => currentSessionGeneration(),
    onSuccess: (_dispute, _variables, generation) => {
      if (generation !== currentSessionGeneration()) return
      void queryClient.invalidateQueries({ queryKey: disputeKeys.detail(disputeId) })
      void queryClient.invalidateQueries({ queryKey: disputeKeys.mine })
    },
    onError: (error, _variables, generation) => {
      if (generation !== currentSessionGeneration()) return
      if (
        error instanceof ApiError &&
        (error.code === 'DISPUTE_NOT_PENDING' || error.code === 'DISPUTE_CONFLICT')
      ) {
        void queryClient.invalidateQueries({ queryKey: disputeKeys.detail(disputeId) })
      }
    },
  })
}

/** 补附件：成功后刷新详情（附件列表与数量都以服务端为准）。 */
export function useUploadDisputeAttachment(disputeId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (file: File) => uploadDisputeAttachment(disputeId, file),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: disputeKeys.detail(disputeId) })
    },
  })
}

/** 关联聊天证据：成功后刷新详情。 */
export function useAddDisputeEvidence(disputeId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (messageId: string) => addDisputeEvidence(disputeId, messageId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: disputeKeys.detail(disputeId) })
    },
  })
}

/**
 * 证据选择器的数据源（交易会话最新一页消息）。
 *
 * `enabled` 只在弹层打开且当前查看者可补材料时给 true —— 非发起人没有这个入口，
 * 不该为他发一次无用的交易/会话请求。
 */
export function useDisputeConversation(transactionId: string, enabled: boolean) {
  return useQuery<DisputeConversation | null>({
    queryKey: disputeKeys.conversation(transactionId),
    queryFn: () => fetchDisputeConversation(transactionId),
    enabled,
    staleTime: 30_000,
  })
}
