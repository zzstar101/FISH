import type { QueryClient } from '@tanstack/react-query'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchListingDetail } from '../listing-detail/api'
import { listingDetailQueryKey } from '../listing-detail/queries'
import {
  fetchNotifications,
  fetchUnreadNotificationCount,
  markNotificationRead,
  NOTIFICATION_PAGE_LIMIT,
} from './api'

export const notificationKeys = {
  listPrefix: ['pc', 'notifications', 'list'] as const,
  list: (limit: number) => ['pc', 'notifications', 'list', limit] as const,
  unread: ['pc', 'notifications', 'unread-count'] as const,
}

export function useNotifications(limit = NOTIFICATION_PAGE_LIMIT) {
  return useQuery({
    queryKey: notificationKeys.list(limit),
    queryFn: () => fetchNotifications(limit),
    staleTime: 30_000,
    // 进入通知页时列表和角标必须同批刷新，避免一个拿到新数据、另一个仍是旧快照。
    refetchOnMount: 'always',
  })
}

export function useUnreadNotificationCount() {
  return useQuery({
    queryKey: notificationKeys.unread,
    queryFn: fetchUnreadNotificationCount,
    staleTime: 30_000,
    refetchOnMount: 'always',
  })
}

/** 跳转前始终重新确认目标商品；新鲜缓存也可能指向刚被删除或下架的商品。 */
export function fetchCurrentListingTarget(queryClient: QueryClient, listingId: string) {
  return queryClient.fetchQuery({
    queryKey: listingDetailQueryKey(listingId),
    queryFn: () => fetchListingDetail(listingId),
    staleTime: 0,
  })
}

export function useMarkNotificationRead() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: markNotificationRead,
    onSuccess: () => {
      // 列表行与独立角标都重新取服务端值，避免本地减法与幂等重试产生分叉。
      void queryClient.invalidateQueries({ queryKey: notificationKeys.listPrefix })
      void queryClient.invalidateQueries({ queryKey: notificationKeys.unread })
    },
  })
}
