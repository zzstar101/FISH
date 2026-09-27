import type { QueryClient } from '@tanstack/react-query'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AUTH_ME_QUERY_KEY, currentSessionGeneration } from '../../lib/session-cache'
import {
  cancelTransaction,
  confirmTransaction,
  fetchMyListings,
  fetchProfile,
  fetchTransaction,
  fetchTransactions,
  type MyListingStatusFilter,
  type OrderStatusFilter,
  setListingStatus,
  updateProfile,
} from './api'

export const profileKeys = {
  all: () => ['pc', 'profile'] as const,
  aggregate: (ownerId: string) => ['pc', 'profile', 'aggregate', ownerId] as const,
  listings: (ownerId: string, status: MyListingStatusFilter) =>
    ['pc', 'profile', 'listings', ownerId, status] as const,
  orders: (ownerId: string, role: 'buyer' | 'seller', status: OrderStatusFilter) =>
    ['pc', 'profile', 'orders', ownerId, role, status] as const,
  order: (ownerId: string, transactionId: string) =>
    ['pc', 'profile', 'order', ownerId, transactionId] as const,
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

export function useSetListingStatus(ownerId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'ACTIVE' | 'OFFLINE' }) =>
      setListingStatus(id, status),
    onMutate: captureSession,
    onSuccess: (detail, variables, context) => {
      if (!isSessionCurrent(context)) return
      queryClient.setQueryData(['pc', 'listings', 'detail', variables.id], detail)
      invalidateProfileSummary(queryClient, ownerId)
      invalidateListingLists(queryClient, ownerId)
      invalidateListingViews(queryClient)
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
      invalidateProfileSummary(queryClient, ownerId)
      invalidateOrderLists(queryClient, ownerId)
      invalidateListingViews(queryClient)
    },
  })
}

export function useConfirmTransaction(ownerId: string) {
  return useTransactionMutation(ownerId, confirmTransaction)
}

export function useCancelTransaction(ownerId: string) {
  return useTransactionMutation(ownerId, cancelTransaction)
}
