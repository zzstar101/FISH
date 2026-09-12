import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  fetchConversation,
  fetchConversations,
  fetchNotificationBadge,
  fetchNotifications,
  markAllNotificationsRead,
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

export function useNotifications() {
  return useQuery({ queryKey: ['notifications'], queryFn: fetchNotifications })
}

export function useNotificationBadge() {
  return useQuery({ queryKey: ['badge'], queryFn: fetchNotificationBadge })
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
