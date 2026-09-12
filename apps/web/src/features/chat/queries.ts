import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  fetchConversation,
  fetchConversations,
  fetchNotificationBadge,
  fetchNotifications,
  fetchUnreadNotificationCount,
  markAllNotificationsRead,
  markNotificationRead,
  meta,
  sendMessage,
} from '../../lib/mock/store'

/** #9 的数据入口。真实实现是 HTTP + WebSocket，替换点集中在本文件（#13）。 */
export { meta }

export function useConversations() {
  return useQuery({ queryKey: ['conversations'], queryFn: fetchConversations })
}

export function useConversation(id: string) {
  return useQuery({ queryKey: ['conversation', id], queryFn: () => fetchConversation(id) })
}

/** #23 通知列表。真实接口是 `GET /notifications`（#13 替换）。 */
export function useNotifications() {
  return useQuery({ queryKey: ['notifications'], queryFn: fetchNotifications })
}

/**
 * 消息 tab 的总未读角标（会话 + 通知）。给底部导航用。
 *
 * 注意与 `useUnreadNotificationCount` 的区别：#23 的 `unread-count` 只算通知。
 * 两个数用途不同——置顶行说的是「有几条通知」，导航角标说的是「消息 tab 有多少没看」。
 */
export function useNotificationBadge() {
  return useQuery({ queryKey: ['badge'], queryFn: fetchNotificationBadge })
}

/** #23 的 `GET /notifications/unread-count`：置顶行的红点。 */
export function useUnreadNotificationCount() {
  return useQuery({ queryKey: ['notifications', 'unread'], queryFn: fetchUnreadNotificationCount })
}

export function useSendMessage(conversationId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (text: string) => sendMessage(conversationId, text),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] })
      void queryClient.invalidateQueries({ queryKey: ['conversations'] })
    },
  })
}

/**
 * 点开单条通知即已读（幂等）。已读会影响列表、未读角标，所以三个 key 一起失效。
 */
export function useMarkNotificationRead() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: markNotificationRead,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] })
      void queryClient.invalidateQueries({ queryKey: ['badge'] })
    },
  })
}

export function useMarkAllRead() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: markAllNotificationsRead,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] })
      void queryClient.invalidateQueries({ queryKey: ['notifications'] })
      void queryClient.invalidateQueries({ queryKey: ['badge'] })
    },
  })
}
