import type { QueryClient } from '@tanstack/react-query'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { currentSessionGeneration } from '../../lib/session-cache'
import {
  closeWish,
  createWish,
  fetchListingMatches,
  fetchMyListingsForMatches,
  fetchMyWishes,
  fetchWish,
  fetchWishMatches,
  fetchWishPool,
  fulfillWish,
  startConversation,
  updateWish,
  type WishStatusFilter,
} from './api'

export const wishKeys = {
  all: () => ['pc', 'wish'] as const,
  pool: (ownerId: string) => ['pc', 'wish', 'pool', ownerId] as const,
  mine: (ownerId: string, status: WishStatusFilter, page: number) =>
    ['pc', 'wish', 'mine', ownerId, status, page] as const,
  detail: (ownerId: string, wishId: string) => ['pc', 'wish', 'detail', ownerId, wishId] as const,
  matches: (ownerId: string, wishId: string) => ['pc', 'wish', 'matches', ownerId, wishId] as const,
  listingMatches: (ownerId: string, listingId: string) =>
    ['pc', 'wish', 'listing-matches', ownerId, listingId] as const,
  myListings: (ownerId: string) => ['pc', 'wish', 'my-listings', ownerId] as const,
}

type SessionMutationContext = { generation: number }

function captureSession(): SessionMutationContext {
  return { generation: currentSessionGeneration() }
}

function isSessionCurrent(context: SessionMutationContext | undefined): boolean {
  return context !== undefined && context.generation === currentSessionGeneration()
}

function invalidateWishData(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: wishKeys.all() })
}

function invalidateProfileData(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['pc', 'profile'] })
}

export function useWishPool(ownerId: string) {
  return useQuery({
    queryKey: wishKeys.pool(ownerId),
    queryFn: fetchWishPool,
    enabled: ownerId !== '',
    staleTime: 30_000,
  })
}

export function useMyWishes(ownerId: string, status: WishStatusFilter, page: number) {
  return useQuery({
    queryKey: wishKeys.mine(ownerId, status, page),
    queryFn: () => fetchMyWishes(status, page),
    enabled: ownerId !== '',
    staleTime: 15_000,
  })
}

/**
 * 单条愿望详情（`GET /wishes/:id`，owner-scoped，#446）。
 *
 * 通知的 wishId 落点：非本人/不存在的愿望都是 404（`wishes/router.ts` 的 getWish），
 * 页面据此渲染「愿望不存在或不可见」，不区分两种原因 —— 与服务端不做存在性混淆同口径。
 */
export function useWishDetail(ownerId: string, wishId: string) {
  return useQuery({
    queryKey: wishKeys.detail(ownerId, wishId),
    queryFn: () => fetchWish(wishId),
    enabled: ownerId !== '' && wishId !== '',
    staleTime: 15_000,
  })
}

export function useMyListingsForMatches(ownerId: string) {
  return useInfiniteQuery({
    queryKey: wishKeys.myListings(ownerId),
    queryFn: ({ pageParam }) => fetchMyListingsForMatches(ownerId, pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: ownerId !== '',
    staleTime: 30_000,
  })
}

export function useWishMatches(ownerId: string, wishId: string, enabled: boolean) {
  return useQuery({
    queryKey: wishKeys.matches(ownerId, wishId),
    queryFn: () => fetchWishMatches(wishId),
    enabled: enabled && ownerId !== '' && wishId !== '',
    staleTime: 15_000,
  })
}

export function useListingMatches(ownerId: string, listingId: string, enabled: boolean) {
  return useQuery({
    queryKey: wishKeys.listingMatches(ownerId, listingId),
    queryFn: () => fetchListingMatches(listingId),
    enabled: enabled && ownerId !== '' && listingId !== '',
    staleTime: 15_000,
  })
}

export function useCreateWish(ownerId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: createWish,
    onMutate: captureSession,
    onSuccess: (_wish, _input, context) => {
      if (!isSessionCurrent(context) || ownerId === '') return
      invalidateWishData(queryClient)
      invalidateProfileData(queryClient)
    },
  })
}

export function useUpdateWish(ownerId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Parameters<typeof updateWish>[1] }) =>
      updateWish(id, input),
    onMutate: captureSession,
    onSuccess: (_wish, _variables, context) => {
      if (!isSessionCurrent(context) || ownerId === '') return
      invalidateWishData(queryClient)
      invalidateProfileData(queryClient)
    },
  })
}

export function useTransitionWish(ownerId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'close' | 'fulfill' }) =>
      action === 'close' ? closeWish(id) : fulfillWish(id),
    onMutate: captureSession,
    onSuccess: (_wish, _variables, context) => {
      if (!isSessionCurrent(context) || ownerId === '') return
      invalidateWishData(queryClient)
      invalidateProfileData(queryClient)
    },
  })
}

export function useStartConversation(ownerId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: startConversation,
    onMutate: captureSession,
    onSuccess: (_conversationId, _listingId, context) => {
      if (!isSessionCurrent(context) || ownerId === '') return
      void queryClient.invalidateQueries({
        queryKey: ['pc', 'chat', 'conversations', ownerId],
      })
      void queryClient.invalidateQueries({ queryKey: ['pc', 'chat', 'unread-count', ownerId] })
    },
  })
}
