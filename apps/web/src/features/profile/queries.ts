import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  fetchBoughtListings,
  fetchFavoriteListings,
  fetchFollowedUsers,
  fetchHistory,
  fetchMyListings,
  fetchProfileSummary,
  fetchSoldListings,
  fetchUser,
  fetchUserListings,
  isFollowing,
  removeListing,
  resetDemoData,
  setListingStatus,
  toggleFollow,
} from '../../lib/mock/store'
import type { ListingStatus } from '../../lib/mock/types'

/** 关注状态与关注动作（用户主页 / 详情页卖家卡共用）。 */
export function useIsFollowing(userId: string) {
  return useQuery({ queryKey: ['follow', userId], queryFn: () => isFollowing(userId) })
}

export function useToggleFollow(userId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => toggleFollow(userId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['follow', userId] })
      void queryClient.invalidateQueries({ queryKey: ['profile'] })
      void queryClient.invalidateQueries({ queryKey: ['mylist', 'follow'] })
    },
  })
}

/**
 * #12 的数据入口（Profile 只做读取聚合）。
 * 写操作（编辑/下架商品）最终属于 Listing Domain，这里通过 store 里的
 * Listing 动作完成，不在 Profile 内复制业务逻辑。
 */
export function useProfileSummary() {
  return useQuery({ queryKey: ['profile'], queryFn: fetchProfileSummary })
}

export function useUser(id: string) {
  return useQuery({ queryKey: ['user', id], queryFn: () => fetchUser(id) })
}

export function useUserListings(id: string) {
  return useQuery({ queryKey: ['user', id, 'listings'], queryFn: () => fetchUserListings(id) })
}

export function useMyListings() {
  return useQuery({ queryKey: ['mylist', 'post'], queryFn: fetchMyListings })
}

export function useFavoriteListings() {
  return useQuery({ queryKey: ['mylist', 'fav'], queryFn: fetchFavoriteListings })
}

export function useSoldListings() {
  return useQuery({ queryKey: ['mylist', 'sold'], queryFn: fetchSoldListings })
}

export function useBoughtListings() {
  return useQuery({ queryKey: ['mylist', 'bought'], queryFn: fetchBoughtListings })
}

export function useHistoryListings() {
  return useQuery({ queryKey: ['mylist', 'history'], queryFn: fetchHistory })
}

export function useFollowedUsers() {
  return useQuery({ queryKey: ['mylist', 'follow'], queryFn: fetchFollowedUsers })
}

export function useSetListingStatus() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: ListingStatus }) =>
      setListingStatus(id, status),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mylist'] })
      void queryClient.invalidateQueries({ queryKey: ['feed'] })
      void queryClient.invalidateQueries({ queryKey: ['profile'] })
    },
  })
}

export function useRemoveListing() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => removeListing(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mylist'] })
      void queryClient.invalidateQueries({ queryKey: ['feed'] })
      void queryClient.invalidateQueries({ queryKey: ['profile'] })
    },
  })
}

export function useResetDemoData() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      resetDemoData()
    },
    onSuccess: () => void queryClient.invalidateQueries(),
  })
}
