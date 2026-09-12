import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  addComment,
  fetchComments,
  fetchListing,
  fetchSimilarListings,
  fetchWatchers,
  openConversationWith,
  toggleFavorite,
} from '../../lib/mock/store'

/**
 * #5 的数据入口。
 * 「我想要」走 `openConversationWith` —— 契约里没有「我想要」接口，
 * 它就是「创建/复用会话」，真实实现由 #9 提供（#13 替换本文件即可）。
 */
export function useListing(id: string) {
  return useQuery({ queryKey: ['listing', id], queryFn: () => fetchListing(id) })
}

export function useSimilarListings(id: string) {
  return useQuery({ queryKey: ['listing', id, 'similar'], queryFn: () => fetchSimilarListings(id) })
}

export function useComments(id: string) {
  return useQuery({ queryKey: ['listing', id, 'comments'], queryFn: () => fetchComments(id) })
}

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

export function useToggleFavorite(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => toggleFavorite(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['listing', id] })
      void queryClient.invalidateQueries({ queryKey: ['feed'] })
      void queryClient.invalidateQueries({ queryKey: ['profile'] })
    },
  })
}

export function useStartConversation() {
  return useMutation({
    mutationFn: ({ peerId, listingId }: { peerId: string; listingId?: string }) =>
      openConversationWith(peerId, listingId),
  })
}
