import type { MessageDto } from '@fish/contracts/chat/schema'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  fetchNotifications as fetchMockNotifications,
  fetchUnreadNotificationCount,
  markAllNotificationsRead,
  markNotificationRead,
  meta,
} from '../../lib/mock/store'
import {
  createConversation,
  fetchConversation,
  fetchConversations,
  fetchMessages,
  markConversationRead,
  sendMessage,
} from './api'

/**
 * #9 的数据入口：会话 / 消息走真实 HTTP（#41），#23 的通知后端尚未立项，
 * 通知相关查询保留 fixture（issue 允许保留 fixture，但不得作为真实路径 fallback）。
 */
export { meta }

export function useConversations() {
  return useQuery({ queryKey: ['chat', 'conversations'], queryFn: fetchConversations })
}

export function useConversation(conversationId: string) {
  return useQuery({
    queryKey: ['chat', 'conversation', conversationId],
    queryFn: () => fetchConversation(conversationId),
  })
}

export function useMessages(conversationId: string) {
  return useQuery({
    queryKey: ['chat', 'messages', conversationId],
    queryFn: () => fetchMessages(conversationId),
  })
}

export function useCreateConversation() {
  return useMutation({
    mutationFn: (listingId: string) => createConversation({ listingId }),
  })
}

export function useSendMessage(conversationId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (text: string) => sendMessage(conversationId, text),
    onSuccess: (message) => {
      // 服务端「先落库推送、再回 HTTP 响应」：WS 推送往往先到，这里必须按 id 去重。
      queryClient.setQueryData<MessageDto[]>(['chat', 'messages', conversationId], (old) => {
        if (!old) return [message]
        return old.some((item) => item.id === message.id) ? old : [...old, message]
      })
      void queryClient.invalidateQueries({ queryKey: ['chat', 'conversations'] })
    },
  })
}

/** 进入会话即标记已读（幂等）；成功后刷新列表让未读角标归零。 */
export function useMarkConversationRead(conversationId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => markConversationRead(conversationId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['chat', 'conversations'] }),
  })
}

/** #23 通知列表（fixture）。 */
export function useNotifications() {
  return useQuery({ queryKey: ['notifications'], queryFn: fetchMockNotifications })
}

/**
 * 底部导航「消息」角标 = 会话未读（真实）+ 通知未读（fixture）。
 *
 * 与 `useUnreadNotificationCount` 的区别：通知未读只算 #23 的通知，
 * 导航角标要连聊天一起算，否则有未读聊天时角标不亮。
 */
export function useNotificationBadge() {
  return useQuery({
    queryKey: ['chat', 'badge'],
    queryFn: async () => {
      const [unreadNotifications, conversations] = await Promise.all([
        fetchUnreadNotificationCount(),
        fetchConversations(),
      ])
      return unreadNotifications + conversations.reduce((sum, item) => sum + item.unreadCount, 0)
    },
  })
}

/** #23 的 `GET /notifications/unread-count`（fixture）：置顶行的红点。 */
export function useUnreadNotificationCount() {
  return useQuery({ queryKey: ['notifications', 'unread'], queryFn: fetchUnreadNotificationCount })
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
      void queryClient.invalidateQueries({ queryKey: ['chat', 'badge'] })
    },
  })
}

export function useMarkAllRead() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: markAllNotificationsRead,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['chat'] })
      void queryClient.invalidateQueries({ queryKey: ['notifications'] })
    },
  })
}
