import type { QueryClient } from '@tanstack/react-query'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchListingDetail } from '../listing-detail/api'
import { listingDetailQueryKey } from '../listing-detail/queries'
import {
  fetchNotifications,
  fetchUnreadNotificationCount,
  markNotificationRead,
  NOTIFICATION_PAGE_LIMIT,
} from './api'

/**
 * 通知轮询间隔。T7 §7 明确实时推送为非目标，P0 允许轮询；这里用有限轮询让顶栏角标和
 * 通知列表保持新鲜。窗口失焦时 TanStack 默认暂停 interval，只在用户正在使用页面时轮询。
 */
export const NOTIFICATION_POLL_INTERVAL_MS = 30_000

export const notificationKeys = {
  listPrefix: ['pc', 'notifications', 'list'] as const,
  list: (limit: number) => ['pc', 'notifications', 'list', limit] as const,
  unread: ['pc', 'notifications', 'unread-count'] as const,
}

export function notificationListQueryOptions(limit = NOTIFICATION_PAGE_LIMIT) {
  return queryOptions({
    queryKey: notificationKeys.list(limit),
    queryFn: () => fetchNotifications(limit),
    staleTime: 30_000,
    // 进入通知页时列表和角标必须同批刷新，避免一个拿到新数据、另一个仍是旧快照。
    refetchOnMount: 'always' as const,
    // 回到窗口立即补一次，不等下一个轮询周期。
    refetchOnWindowFocus: 'always' as const,
    refetchInterval: NOTIFICATION_POLL_INTERVAL_MS,
  })
}

export function notificationUnreadQueryOptions(enabled = true) {
  return queryOptions({
    queryKey: notificationKeys.unread,
    queryFn: fetchUnreadNotificationCount,
    // 匿名访问公开详情 / 404 时也会渲染顶栏；未登录不能请求未读数，
    // 否则 401 会触发全局跳登录，把匿名浏览者挤出公开页。
    enabled,
    staleTime: 30_000,
    refetchOnMount: 'always' as const,
    refetchOnWindowFocus: 'always' as const,
    refetchInterval: enabled ? NOTIFICATION_POLL_INTERVAL_MS : false,
  })
}

export function useNotifications(limit = NOTIFICATION_PAGE_LIMIT) {
  return useQuery(notificationListQueryOptions(limit))
}

export function useUnreadNotificationCount(enabled = true) {
  return useQuery(notificationUnreadQueryOptions(enabled))
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
