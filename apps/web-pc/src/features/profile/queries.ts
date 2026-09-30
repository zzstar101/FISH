import type { QueryClient } from '@tanstack/react-query'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AUTH_ME_QUERY_KEY, currentSessionGeneration } from '../../lib/session-cache'
import { fetchConversationPage, fetchMessagePage } from '../chat/api'
import { listingDetailQueryKey } from '../listing-detail/queries'
import {
  acceptTransaction,
  cancelTransaction,
  confirmTransaction,
  fetchMeetupTokenStatus,
  fetchMyListings,
  fetchProfile,
  fetchTransaction,
  fetchTransactions,
  issueMeetupToken,
  type MyListingStatusFilter,
  type OrderStatusFilter,
  redeemMeetupToken,
  rejectProposal,
  setListingStatus,
  updateListing,
  updateProfile,
  verifyMeetupCode,
} from './api'
import { loadPendingIndex, type PendingIndex } from './pending'

export const profileKeys = {
  all: () => ['pc', 'profile'] as const,
  aggregate: (ownerId: string) => ['pc', 'profile', 'aggregate', ownerId] as const,
  listings: (ownerId: string, status: MyListingStatusFilter) =>
    ['pc', 'profile', 'listings', ownerId, status] as const,
  orders: (ownerId: string, role: 'buyer' | 'seller', status: OrderStatusFilter) =>
    ['pc', 'profile', 'orders', ownerId, role, status] as const,
  order: (ownerId: string, transactionId: string) =>
    ['pc', 'profile', 'order', ownerId, transactionId] as const,
  pending: (ownerId: string) => ['pc', 'profile', 'pending', ownerId] as const,
  meetupToken: (ownerId: string, transactionId: string) =>
    ['pc', 'profile', 'meetup-token', ownerId, transactionId] as const,
}

type SessionMutationContext = { generation: number }

function captureSession(): SessionMutationContext {
  return { generation: currentSessionGeneration() }
}

function isSessionCurrent(context: SessionMutationContext | undefined): boolean {
  return context !== undefined && context.generation === currentSessionGeneration()
}

function invalidateProfileSummary(queryClient: QueryClient, ownerId: string): void {
  void queryClient.invalidateQueries({ queryKey: profileKeys.aggregate(ownerId) })
}

function invalidateListingLists(queryClient: QueryClient, ownerId: string): void {
  void queryClient.invalidateQueries({ queryKey: ['pc', 'profile', 'listings', ownerId] })
}

function invalidateOrderLists(queryClient: QueryClient, ownerId: string): void {
  void queryClient.invalidateQueries({ queryKey: ['pc', 'profile', 'orders', ownerId] })
}

function invalidateListingViews(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['pc', 'listings'] })
}

function invalidateChatSurfaces(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['pc', 'chat'] })
}

function invalidatePending(queryClient: QueryClient, ownerId: string): void {
  void queryClient.invalidateQueries({ queryKey: profileKeys.pending(ownerId) })
}

export function invalidateTransactionSurfaces(queryClient: QueryClient, ownerId: string): void {
  invalidateProfileSummary(queryClient, ownerId)
  invalidateOrderLists(queryClient, ownerId)
  invalidateListingLists(queryClient, ownerId)
  invalidateListingViews(queryClient)
  invalidateChatSurfaces(queryClient)
}

export function useProfile(ownerId: string) {
  return useQuery({
    queryKey: profileKeys.aggregate(ownerId),
    queryFn: fetchProfile,
    enabled: ownerId !== '',
    staleTime: 15_000,
  })
}

export function useMyListings(ownerId: string, status: MyListingStatusFilter) {
  return useQuery({
    queryKey: profileKeys.listings(ownerId, status),
    queryFn: () => fetchMyListings(ownerId, status),
    enabled: ownerId !== '',
    staleTime: 15_000,
  })
}

export function useOrders(ownerId: string, role: 'buyer' | 'seller', status: OrderStatusFilter) {
  return useQuery({
    queryKey: profileKeys.orders(ownerId, role, status),
    queryFn: () => fetchTransactions({ role, status }),
    enabled: ownerId !== '',
    staleTime: 15_000,
  })
}

export function useOrder(ownerId: string, transactionId: string) {
  return useQuery({
    queryKey: profileKeys.order(ownerId, transactionId),
    queryFn: () => fetchTransaction(transactionId),
    enabled: ownerId !== '' && transactionId !== '',
    staleTime: 15_000,
  })
}

export function useUpdateProfile(ownerId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: updateProfile,
    onMutate: captureSession,
    onSuccess: (user, _input, context) => {
      if (!isSessionCurrent(context)) return
      queryClient.setQueryData(AUTH_ME_QUERY_KEY, user)
      invalidateProfileSummary(queryClient, ownerId)
    },
  })
}

export function useUpdateListing(ownerId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Parameters<typeof updateListing>[1] }) =>
      updateListing(id, input),
    onMutate: captureSession,
    onSuccess: (detail, variables, context) => {
      if (!isSessionCurrent(context)) return
      queryClient.setQueryData(listingDetailQueryKey(variables.id, ownerId), detail)
      invalidateProfileSummary(queryClient, ownerId)
      invalidateListingLists(queryClient, ownerId)
      invalidateListingViews(queryClient)
      invalidateChatSurfaces(queryClient)
    },
  })
}

export function useSetListingStatus(ownerId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'ACTIVE' | 'OFFLINE' }) =>
      setListingStatus(id, status),
    onMutate: captureSession,
    onSuccess: (detail, variables, context) => {
      if (!isSessionCurrent(context)) return
      queryClient.setQueryData(listingDetailQueryKey(variables.id, ownerId), detail)
      invalidateProfileSummary(queryClient, ownerId)
      invalidateListingLists(queryClient, ownerId)
      invalidateListingViews(queryClient)
      invalidateChatSurfaces(queryClient)
    },
  })
}

function useTransactionMutation(
  ownerId: string,
  mutationFn: (transactionId: string) => ReturnType<typeof confirmTransaction>,
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn,
    onMutate: captureSession,
    onSuccess: (transaction, transactionId, context) => {
      if (!isSessionCurrent(context)) return
      queryClient.setQueryData(profileKeys.order(ownerId, transactionId), transaction)
      invalidateTransactionSurfaces(queryClient, ownerId)
    },
  })
}

export function useConfirmTransaction(ownerId: string) {
  return useTransactionMutation(ownerId, confirmTransaction)
}

export function useCancelTransaction(ownerId: string) {
  return useTransactionMutation(ownerId, cancelTransaction)
}

const EMPTY_PENDING: PendingIndex = {
  proposals: new Map(),
  complete: true,
  failed: false,
}

/**
 * 卖家侧「谁在等我点头」的推导（口径见 `./pending` 文件头）。
 *
 * 商品**状态一并交给推导**（见 `./pending` 的 `ACTIONABLE_STATUSES`），这里不做筛选：
 * 服务端对接受与拒绝的要求不对称 —— 接受要求商品仍 `ACTIVE`，拒绝不看商品状态 ——
 * 所以「哪些状态还能处理」这件事只有推导侧一个地方说了算。
 *
 * id 全集独立取一次，不跟着「我的发布」当前标签页走：标签页可能停在「已下架 / 已预定」。
 */
export function usePendingProposals(ownerId: string) {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: profileKeys.pending(ownerId),
    queryFn: async () => {
      // 走 `useMyListings` 的同一个查询键：标签页停在「全部」时复用它的响应，
      // 不为了拿 id 再拉一遍商品列表。
      const listings = await queryClient.fetchQuery({
        queryKey: profileKeys.listings(ownerId, 'ALL'),
        queryFn: () => fetchMyListings(ownerId, 'ALL'),
        staleTime: 15_000,
      })
      if (listings.items.length === 0) return EMPTY_PENDING
      const byId = new Map(listings.items.map((item) => [item.id, item.status]))
      return loadPendingIndex(byId, fetchConversationPage, fetchMessagePage)
    },
    enabled: ownerId !== '',
    staleTime: 15_000,
  })
}

export type ProposalDecisionVariables = { conversationId: string; amountCents: number }

/**
 * 同意提案：唯一创建交易行的写操作。
 *
 * 成功后商品转 `RESERVED`，因此除了交易面还要失效待确认推导 —— 这一件不该再出现在
 * 「待确认」里，其余买家留在会话里的 `tx.proposal` 也不再有可操作性。
 */
export function useAcceptProposal(ownerId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ conversationId, amountCents }: ProposalDecisionVariables) =>
      acceptTransaction(conversationId, amountCents),
    onMutate: captureSession,
    onSuccess: (transaction, _variables, context) => {
      if (!isSessionCurrent(context)) return
      queryClient.setQueryData(profileKeys.order(ownerId, transaction.id), transaction)
      invalidateTransactionSurfaces(queryClient, ownerId)
      invalidatePending(queryClient, ownerId)
    },
  })
}

/** 拒绝提案：只写一条 `tx.rejected`，商品留在在售，所以只失效会话面与推导。 */
export function useRejectProposal(ownerId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ conversationId }: ProposalDecisionVariables) => rejectProposal(conversationId),
    onMutate: captureSession,
    onSuccess: (_message, _variables, context) => {
      if (!isSessionCurrent(context)) return
      invalidateChatSurfaces(queryClient)
      invalidatePending(queryClient, ownerId)
    },
  })
}

/**
 * 面交凭证状态（不含明文码）。
 *
 * `enabled` 由页面按「交易处于 PENDING_MEETUP」给：终态订单不该再去问凭证，
 * 免得给只读页面拉出一个永远不会有值的请求。
 */
export function useMeetupTokenStatus(ownerId: string, transactionId: string, enabled: boolean) {
  return useQuery({
    queryKey: profileKeys.meetupToken(ownerId, transactionId),
    queryFn: () => fetchMeetupTokenStatus(transactionId),
    enabled: enabled && ownerId !== '' && transactionId !== '',
    staleTime: 15_000,
  })
}

function invalidateMeetupToken(
  queryClient: QueryClient,
  ownerId: string,
  transactionId: string,
): void {
  void queryClient.invalidateQueries({
    queryKey: profileKeys.meetupToken(ownerId, transactionId),
  })
}

/**
 * 卖家取码。幂等「确保并读取」，所以重取不会换码；成功后只失效凭证状态
 * （明文码由调用方留在组件状态里，不进缓存 —— 缓存会被 devtools / 序列化带出去）。
 */
export function useIssueMeetupToken(ownerId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (transactionId: string) => issueMeetupToken(transactionId),
    onMutate: captureSession,
    onSuccess: (_token, transactionId, context) => {
      if (!isSessionCurrent(context)) return
      invalidateMeetupToken(queryClient, ownerId, transactionId)
    },
  })
}

export type RedeemVariables = {
  transactionId: string
  input: { kind: 'code'; code: string } | { kind: 'qr'; token: string }
}

/**
 * 核销（6 位码或二维码载荷）。
 *
 * 成功只代表「凭证已消费」，交易仍是 `PENDING_MEETUP` —— 契约用
 * `nextAction: 'CONFIRM_DELIVERY'` 表达下一步是双方各确认一次，页面据此引导到
 * 已有的「确认完成面交」，这里不替它推进终态。
 */
export function useRedeemMeetupToken(ownerId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ transactionId, input }: RedeemVariables) =>
      input.kind === 'code'
        ? verifyMeetupCode(transactionId, input.code)
        : redeemMeetupToken(transactionId, input.token),
    onMutate: captureSession,
    onSuccess: (_verification, variables, context) => {
      if (!isSessionCurrent(context)) return
      invalidateMeetupToken(queryClient, ownerId, variables.transactionId)
      void queryClient.invalidateQueries({
        queryKey: profileKeys.order(ownerId, variables.transactionId),
      })
    },
  })
}
