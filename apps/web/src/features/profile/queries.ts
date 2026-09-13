import type { ListingStatus } from '@fish/contracts/listings/schema'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  fetchFavoriteListings,
  fetchFollowedUsers,
  fetchHistory,
  fetchUser,
  fetchUserListings,
  isFollowing,
  resetDemoData,
  toggleFollow,
} from '../../lib/mock/store'
import { useMe } from '../auth/queries'
import { offlineListing, onlineListing } from '../listing/api'
import { fetchMyListingLists, fetchProfileSummary } from './api'

/**
 * #12 的数据入口：个人中心聚合走真实 `/profile`，我发布的/在售/卖出走真实
 * Listing 读路径（#41）。收藏 / 浏览历史 / 关注是 fixture（契约无对应端点）。
 * 写操作（上下架）属于 Listing Domain，直接调用 #6 的 offline/online 端点。
 */
export function useProfileSummary() {
  return useQuery({ queryKey: ['profile'], queryFn: fetchProfileSummary })
}

/** 关注状态与关注动作（fixture：详情页卖家卡共用，真实契约无关注端点）。 */
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
 * 用户主页（fixture）：真实契约没有公开用户资料端点（P1 信用/主页）。
 * `useUserListings(userId)` 仍走 fixture store，服务用户主页与我的列表两处。
 */
export function useUser(id: string) {
  return useQuery({ queryKey: ['user', id], queryFn: () => fetchUser(id) })
}

export function useUserListings(id: string) {
  return useQuery({ queryKey: ['user', id, 'listings'], queryFn: () => fetchUserListings(id) })
}

/** 「我发布的 / 在售 / 我卖出的」分页：真实 sellerId 读路径（需要当前用户 id）。 */
export function useMyListingLists() {
  const meId = useMe().data?.id ?? ''
  return useQuery({
    queryKey: ['mylist', 'all', meId],
    queryFn: () => fetchMyListingLists(meId),
    enabled: Boolean(meId),
  })
}

export function useFavoriteListings() {
  return useQuery({ queryKey: ['mylist', 'fav'], queryFn: fetchFavoriteListings })
}

export function useHistoryListings() {
  return useQuery({ queryKey: ['mylist', 'history'], queryFn: fetchHistory })
}

export function useFollowedUsers() {
  return useQuery({ queryKey: ['mylist', 'follow'], queryFn: fetchFollowedUsers })
}

/**
 * 上下架写操作（#6）：
 * - 下架 = ACTIVE → OFFLINE（契约只有这一条「收回」路径，没有删除端点）；
 * - 重新上架 = OFFLINE → ACTIVE（SOLD 是交易流程写的终态，契约不允许手动改回）。
 */
export function useSetListingStatus() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      status,
    }: {
      id: string
      status: Extract<ListingStatus, 'ACTIVE' | 'OFFLINE'>
    }) => (status === 'ACTIVE' ? onlineListing(id) : offlineListing(id)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mylist'] })
      void queryClient.invalidateQueries({ queryKey: ['feed'] })
      void queryClient.invalidateQueries({ queryKey: ['profile'] })
      void queryClient.invalidateQueries({ queryKey: ['listing'] })
    },
  })
}

/** 「清除演示数据」仍只作用于 fixture（收藏/历史/关注等），真实数据不动。 */
export function useResetDemoData() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      resetDemoData()
    },
    onSuccess: () => void queryClient.invalidateQueries(),
  })
}
