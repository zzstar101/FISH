import type { WishCreateInput } from '@fish/contracts/wishes/schema'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchWishMatches } from '../match/api'
import { closeWish, createWish, fetchMyWishes, fetchWishPool } from './api'

/**
 * #7 的数据入口：愿望 CRUD 走真实 `/api/wishes`（#41）。
 * 愿望成真的命中商品走 #8 的 `/matches?wishId=`（match/api.ts）。
 */
export function useMyWishes() {
  return useQuery({ queryKey: ['wishes', 'mine'], queryFn: fetchMyWishes })
}

export function useWishPool() {
  return useQuery({ queryKey: ['wishes', 'pool'], queryFn: fetchWishPool })
}

/** 单条愿望的命中商品（愿望成真）。挂在愿望卡里，按需启用。 */
export function useWishMatches(wishId: string, enabled = true) {
  return useQuery({
    queryKey: ['match', 'wish', wishId],
    queryFn: () => fetchWishMatches(wishId),
    enabled,
  })
}

export function useCreateWish() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: WishCreateInput) => createWish(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['wishes'] })
      void queryClient.invalidateQueries({ queryKey: ['profile'] })
    },
  })
}

export function useCloseWish() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => closeWish(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['wishes'] })
      void queryClient.invalidateQueries({ queryKey: ['match'] })
      void queryClient.invalidateQueries({ queryKey: ['profile'] })
    },
  })
}
