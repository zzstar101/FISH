import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
 */
export function useMyDisputes(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: disputeKeys.mine,
    queryFn: ({ pageParam }) => fetchMyDisputes(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled,
    staleTime: 30_000,
  })
}

/** 详情轮询交给用户操作后的 invalidate，不做后台定时（争议不是高频变化的面板）。 */
export function useDispute(disputeId: string) {
  return useQuery({
    queryKey: disputeKeys.detail(disputeId),
    queryFn: () => fetchDispute(disputeId),
    staleTime: DISPUTE_DETAIL_STALE_MS,
  })
}

/**
 * 发起争议。成功后把服务端返回的详情直接写进缓存（新建与复用未决单都是完整详情），
 * 同时让「我的争议」失效 —— 新争议要立刻出现在列表里。
 */
export function useStartDispute() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: startDispute,
    onSuccess: (result) => {
      queryClient.setQueryData(disputeKeys.detail(result.dispute.id), result.dispute)
      void queryClient.invalidateQueries({ queryKey: disputeKeys.mine })
    },
  })
}

/** 撤回：服务端返回完整详情，直接替换详情缓存并刷新列表状态。 */
export function useWithdrawDispute(disputeId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => withdrawDispute(disputeId),
    onSuccess: (dispute) => {
      queryClient.setQueryData(disputeKeys.detail(disputeId), dispute)
      void queryClient.invalidateQueries({ queryKey: disputeKeys.mine })
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
