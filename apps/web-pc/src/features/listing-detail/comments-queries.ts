import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { createComment, createReply, deleteComment, fetchCommentPage } from './comments-api'

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

/**
 * 删除自己的一条留言。
 *
 * 成功后整列重取而不是本地摘除：删顶层留言会**级联**带走下面别人的回复，
 * 本地只摘一行会留下「N 条回复」与实际不符的残影 —— 服务端才是唯一口径。
 * 幂等（重复删除 `{ deleted: 0 }`）也由它兜底：本地无需区分「删过没删过」。
 */
export function useDeleteComment(listingId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (commentId: string) => deleteComment(commentId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: commentKeys.ofListing(listingId) })
    },
  })
}
