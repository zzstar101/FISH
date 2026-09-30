import type { QueryClient } from '@tanstack/react-query'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AUTH_ME_QUERY_KEY, currentSessionGeneration } from '../../lib/session-cache'
import { fetchConversationPage, fetchMessagePage } from '../chat/api'
import { listingDetailQueryKey } from '../listing-detail/queries'
import {
  acceptTransaction,
  cancelTransaction,
  confirmTransaction,
  fetchMyListings,
  fetchProfile,
  fetchTransaction,
  fetchTransactions,
  type MyListingStatusFilter,
  type OrderStatusFilter,
  rejectProposal,
  setListingStatus,
  updateListing,
  updateProfile,
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
 * 自己拉一遍名下商品（`status=ALL`）拿 id 全集：**不能**只用手上那一页列表 ——
 * 「我的发布」的标签页可能停在「已下架」，而待确认的申请挂在 `ACTIVE` 商品上，
 * 换个标签页就会整段消失。响应体与 `useMyListings` 共用查询键，正常情况下不产生
 * 第二次请求。
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
      const ids = new Set(listings.items.map((item) => item.id))
      if (ids.size === 0) return EMPTY_PENDING
      return loadPendingIndex(ids, fetchConversationPage, fetchMessagePage)
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
