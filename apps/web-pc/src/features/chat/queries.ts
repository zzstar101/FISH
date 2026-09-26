import type {
  ConversationDto,
  ConversationListResponse,
  MessageDto,
  MessageListResponse,
} from '@fish/contracts/chat/schema'
import type { InfiniteData, QueryClient } from '@tanstack/react-query'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  fetchConversation,
  fetchConversationPage,
  fetchConversationUnreadCount,
  fetchMessagePage,
  markConversationRead,
  sendTextMessage,
} from './api'

export const chatKeys = {
  all: () => ['pc', 'chat'] as const,
  conversations: (ownerId: string | null) => ['pc', 'chat', 'conversations', ownerId] as const,
  conversation: (ownerId: string | null, conversationId: string) =>
    ['pc', 'chat', 'conversation', ownerId, conversationId] as const,
  messages: (ownerId: string | null, conversationId: string) =>
    ['pc', 'chat', 'messages', ownerId, conversationId] as const,
  unreadCount: (ownerId: string | null) => ['pc', 'chat', 'unread-count', ownerId] as const,
}

export function useConversationList(ownerId: string | null) {
  return useInfiniteQuery({
    queryKey: chatKeys.conversations(ownerId),
    queryFn: ({ pageParam }) => fetchConversationPage(pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: ownerId !== null,
    staleTime: 15_000,
  })
}

export function useConversation(ownerId: string | null, conversationId: string) {
  return useQuery({
    queryKey: chatKeys.conversation(ownerId, conversationId),
    queryFn: () => fetchConversation(conversationId),
    enabled: ownerId !== null,
    staleTime: 15_000,
  })
}

export function useMessageHistory(ownerId: string | null, conversationId: string) {
  return useInfiniteQuery({
    queryKey: chatKeys.messages(ownerId, conversationId),
    queryFn: ({ pageParam }) => fetchMessagePage(conversationId, pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: ownerId !== null,
    staleTime: 15_000,
  })
}

export function useConversationUnreadCount(ownerId: string | null) {
  return useQuery({
    queryKey: chatKeys.unreadCount(ownerId),
    queryFn: fetchConversationUnreadCount,
    enabled: ownerId !== null,
    staleTime: 15_000,
  })
}

export function useMarkConversationRead(ownerId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (conversationId: string) => markConversationRead(conversationId),
    onSuccess: (conversation) => {
      if (ownerId === null) return
      updateConversationCaches(queryClient, ownerId, conversation)
      void queryClient.invalidateQueries({ queryKey: chatKeys.unreadCount(ownerId) })
    },
  })
}

export type SendTextVariables = {
  conversationId: string
  input: {
    content: string
    clientRequestId: string
  }
}

export function useSendTextMessage(ownerId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ conversationId, input }: SendTextVariables) =>
      sendTextMessage(conversationId, input),
    onSuccess: (message, variables) => {
      if (ownerId === null) return
      insertMessageIntoCache(queryClient, ownerId, variables.conversationId, message)
      void queryClient.invalidateQueries({ queryKey: chatKeys.conversations(ownerId) })
      void queryClient.invalidateQueries({ queryKey: chatKeys.unreadCount(ownerId) })
    },
  })
}

/** 按 (createdAt, id) 排序，与服务端消息顺序口径一致。 */
export function compareMessages(a: MessageDto, b: MessageDto): number {
  const byTime = Date.parse(a.createdAt) - Date.parse(b.createdAt)
  if (byTime !== 0) return byTime
  return a.id.localeCompare(b.id)
}

/**
 * 把实时 / 发送返回的消息合进无限查询缓存。
 *
 * 服务端按升序返回，第一页是最新页；新消息只可能进入第一页。若该 id 已存在
 * （重试命中、实时推送与 HTTP 响应同时到达）则原位替换，不重复插入。
 */
function sameMessage(a: MessageDto, b: MessageDto): boolean {
  return (
    a.id === b.id &&
    a.conversationId === b.conversationId &&
    a.senderId === b.senderId &&
    a.type === b.type &&
    a.content === b.content &&
    a.createdAt === b.createdAt
  )
}

export function upsertMessagePage<TPageParam>(
  data: InfiniteData<MessageListResponse, TPageParam> | undefined,
  message: MessageDto,
): InfiniteData<MessageListResponse, TPageParam> | undefined {
  if (!data || data.pages.length === 0) return data

  let replaced = false
  let identical = false
  const pages = data.pages.map((page) => {
    const index = page.items.findIndex((item) => item.id === message.id)
    if (index < 0) return page
    const existing = page.items[index]
    if (existing && sameMessage(existing, message)) {
      identical = true
      return page
    }
    replaced = true
    const items = [...page.items]
    items[index] = message
    return { ...page, items }
  })
  if (replaced) return { ...data, pages }
  if (identical) return data

  const newest = pages[0]
  if (!newest) return data
  const items = [...newest.items, message].sort(compareMessages)
  return { ...data, pages: [{ ...newest, items }, ...pages.slice(1)] }
}

export function insertMessageIntoCache(
  queryClient: QueryClient,
  ownerId: string,
  conversationId: string,
  message: MessageDto,
): void {
  queryClient.setQueryData<InfiniteData<MessageListResponse, string | null>>(
    chatKeys.messages(ownerId, conversationId),
    (data) => upsertMessagePage(data, message),
  )
}

/**
 * 把一批本地实时 / 发送消息重新合进缓存。
 *
 * 用途：TanStack infinite query 在分页请求完成时会用发起时的旧页整体写回，
 * 期间通过 `insertMessageIntoCache` 写入的新消息可能被覆盖。页面在
 * `isFetching` 落回 false 后再 merge 一次，保证实时消息不丢。
 */
export function mergeMessagesIntoCache(
  queryClient: QueryClient,
  ownerId: string,
  conversationId: string,
  messages: MessageDto[],
): void {
  if (messages.length === 0) return
  queryClient.setQueryData<InfiniteData<MessageListResponse, string | null>>(
    chatKeys.messages(ownerId, conversationId),
    (data) => messages.reduce((current, message) => upsertMessagePage(current, message), data),
  )
}

/** 渲染用时间序：最新页在前，反转后按升序拼接。 */
export function flattenMessagePages<TPageParam>(
  data: InfiniteData<MessageListResponse, TPageParam> | undefined,
): MessageDto[] {
  if (!data) return []
  return [...data.pages].reverse().flatMap((page) => page.items)
}

export function isMessageRead(message: MessageDto, counterpartLastReadAt: string | null): boolean {
  if (message.senderId === null || counterpartLastReadAt === null) return false
  return Date.parse(message.createdAt) <= Date.parse(counterpartLastReadAt)
}

export function updateConversationCaches(
  queryClient: QueryClient,
  ownerId: string,
  conversation: ConversationDto,
): void {
  queryClient.setQueryData(chatKeys.conversation(ownerId, conversation.id), conversation)
  queryClient.setQueryData<InfiniteData<ConversationListResponse, string | null>>(
    chatKeys.conversations(ownerId),
    (data) => updateConversationPage(data, conversation),
  )
}

/**
 * 只更新已在列表页里的会话行。
 *
 * 服务端按 `lastMessageAt` 排序；本地找不到时不能凭一次 read/事件把它插到头部，
 * 否则会破坏服务端顺序。新会话由列表失效后的服务端响应补齐。
 */
export function updateConversationPage(
  data: InfiniteData<ConversationListResponse, string | null> | undefined,
  conversation: ConversationDto,
): InfiniteData<ConversationListResponse, string | null> | undefined {
  if (!data || data.pages.length === 0) return data

  let found = false
  const pages = data.pages.map((page) => {
    const index = page.items.findIndex((item) => item.id === conversation.id)
    if (index < 0) return page
    found = true
    const items = [...page.items]
    items[index] = conversation
    return { ...page, items }
  })
  return found ? { ...data, pages } : data
}

/** 对方读位推进事件：只有 readerId !== me 才更新自己的「已读」判据。 */
export function applyReadEventToCache(
  queryClient: QueryClient,
  ownerId: string,
  event: { conversationId: string; readerId: string; readAt: string },
): void {
  if (event.readerId === ownerId) return

  queryClient.setQueryData<ConversationDto | null>(
    chatKeys.conversation(ownerId, event.conversationId),
    (current) => {
      if (!current) return current
      if (
        current.counterpartLastReadAt !== null &&
        Date.parse(current.counterpartLastReadAt) >= Date.parse(event.readAt)
      ) {
        return current
      }
      return { ...current, counterpartLastReadAt: event.readAt }
    },
  )

  queryClient.setQueryData<InfiniteData<ConversationListResponse, string | null>>(
    chatKeys.conversations(ownerId),
    (data) => updateConversationReadAt(data, event.conversationId, event.readAt),
  )
}

function updateConversationReadAt(
  data: InfiniteData<ConversationListResponse, string | null> | undefined,
  conversationId: string,
  readAt: string,
): InfiniteData<ConversationListResponse, string | null> | undefined {
  if (!data) return data

  let changed = false
  const pages = data.pages.map((page) => {
    let pageChanged = false
    const items = page.items.map((item) => {
      if (item.id !== conversationId) return item
      if (
        item.counterpartLastReadAt !== null &&
        Date.parse(item.counterpartLastReadAt) >= Date.parse(readAt)
      ) {
        return item
      }
      pageChanged = true
      return { ...item, counterpartLastReadAt: readAt }
    })
    if (!pageChanged) return page
    changed = true
    return { ...page, items }
  })
  return changed ? { ...data, pages } : data
}

/** 新消息 / 读位事件发生后，要求列表与未读总数回到服务端口径。 */
export function invalidateConversationSurfaces(queryClient: QueryClient, ownerId: string): void {
  void queryClient.invalidateQueries({ queryKey: chatKeys.conversations(ownerId) })
  void queryClient.invalidateQueries({ queryKey: chatKeys.unreadCount(ownerId) })
}

/** 重连后补当前会话详情与历史。 */
export function invalidateConversationDetail(
  queryClient: QueryClient,
  ownerId: string,
  conversationId: string,
): void {
  void queryClient.invalidateQueries({ queryKey: chatKeys.conversation(ownerId, conversationId) })
  void queryClient.invalidateQueries({ queryKey: chatKeys.messages(ownerId, conversationId) })
}
