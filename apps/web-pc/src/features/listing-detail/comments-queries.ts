import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { createComment, createReply, fetchCommentPage } from './comments-api'

export const commentKeys = {
  ofListing: (listingId: string) => ['pc', 'comments', 'listing', listingId] as const,
}

export function useCommentList(listingId: string) {
  return useInfiniteQuery({
    queryKey: commentKeys.ofListing(listingId),
    queryFn: ({ pageParam }) => fetchCommentPage(listingId, pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 15_000,
  })
}

export function useCreateComment(listingId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (content: string) => createComment(listingId, content),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: commentKeys.ofListing(listingId) })
    },
  })
}

export function useCreateReply(listingId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ commentId, content }: { commentId: string; content: string }) =>
      createReply(commentId, content),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: commentKeys.ofListing(listingId) })
    },
  })
}
