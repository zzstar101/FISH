import type { ListingCategory } from '@fish/contracts/listings/schema'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  addComment,
  fetchComments,
  fetchWatchers,
  isFavorite,
  toggleFavorite,
} from '../../lib/mock/store'
import { createConversation } from '../chat/api'
import { fetchListingDetail, fetchSimilarListings } from '../listing/api'

/**
 * #5 的数据入口。商品详情与同类好物走真实 Listing API（#41）；
 * 「我想要 / 聊一聊」走真实 Conversation（#9 契约：POST /conversations，复用即幂等）。
 *
 * 留言与收藏是 fixture（真实契约没有对应端点）：商品 id 已是真实 uuid，
 * fixture 数据按 id 工作，与真实路径互不干扰。
 */
export function useListing(id: string) {
  return useQuery({ queryKey: ['listing', id], queryFn: () => fetchListingDetail(id) })
}

export function useSimilarListings(category: ListingCategory | null, excludeId: string) {
  return useQuery({
    queryKey: ['listing', excludeId, 'similar', category],
    queryFn: () => (category ? fetchSimilarListings(category, excludeId) : Promise.resolve([])),
    enabled: category !== null,
  })
}

export function useComments(id: string) {
  return useQuery({ queryKey: ['listing', id, 'comments'], queryFn: () => fetchComments(id) })
}

/** 「谁在关注」（fixture）：真实契约没有想要者/关注名单端点。 */
export function useWatchers(id: string) {
  return useQuery({ queryKey: ['listing', id, 'watchers'], queryFn: () => fetchWatchers(id) })
}

export function useAddComment(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (text: string) => addComment(id, text),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['listing', id, 'comments'] }),
  })
}

/** 收藏状态初值取自 fixture 收藏列表；真实契约没有收藏端点（#14 P1）。 */
export function useIsFavorite(id: string) {
  return useQuery({
    queryKey: ['favorite', id],
    queryFn: async () => isFavorite(id),
    initialData: () => isFavorite(id),
  })
}

export function useToggleFavorite(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => toggleFavorite(id),
    onSuccess: (favorited) => {
      queryClient.setQueryData(['favorite', id], favorited)
      void queryClient.invalidateQueries({ queryKey: ['mylist', 'fav'] })
    },
  })
}

export function useStartConversation() {
  return useMutation({
    mutationFn: (listingId: string) => createConversation({ listingId }),
  })
}
