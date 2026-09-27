import type { Me } from '@fish/contracts/auth/user'
import type {
  ConversationDto,
  ConversationListResponse,
  MessageDto,
  MessageListResponse,
} from '@fish/contracts/chat/schema'
import type { InfiniteData, QueryClient } from '@tanstack/react-query'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AUTH_ME_QUERY_KEY } from '../../lib/session-cache'
import {
  createConversation,
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
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: chatKeys.conversation(ownerId, conversationId),
    queryFn: async () => {
      const fetched = await fetchConversation(conversationId)
      if (fetched === null || ownerId === null) return fetched
      const current = queryClient.getQueryData<ConversationDto | null>(
        chatKeys.conversation(ownerId, conversationId),
      )
      return mergeConversationDto(current, fetched)
    },
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

/**
 * 只把会话写入仍属于该 mutation 发起账号的缓存。
 * 公开详情页在切号后不会卸载，迟到的 POST 不能用新账号 ownerId 覆盖缓存。
 */
export function updateConversationForOwner(
  queryClient: QueryClient,
  ownerId: string,
  conversation: ConversationDto,
): boolean {
  const currentOwnerId = queryClient.getQueryData<Me | null>(AUTH_ME_QUERY_KEY)?.id ?? null
  if (currentOwnerId !== ownerId) return false
  updateConversationCaches(queryClient, ownerId, conversation)
  return true
}

export function useCreateConversation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ listingId }: { listingId: string; ownerId: string }) =>
      createConversation(listingId),
    onSuccess: (conversation, variables) => {
      if (!updateConversationForOwner(queryClient, variables.ownerId, conversation)) return
      void queryClient.invalidateQueries({ queryKey: chatKeys.unreadCount(variables.ownerId) })
    },
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
    retry: 1,
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
    onSuccess: () => {
      if (ownerId === null) return
      // 消息缓存由页面按历史查询状态决定是否写入：历史处于错误态时不能写伪页，
      // 否则会把可重试的 error 状态改成 success。
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

export function upsertMessagePage(
  data: InfiniteData<MessageListResponse, string | null> | undefined,
  message: MessageDto,
  conversationId: string,
): InfiniteData<MessageListResponse, string | null> | undefined {
  if (message.conversationId !== conversationId) return data
  if (!data || data.pages.length === 0) {
    return { pages: [{ items: [message], nextCursor: null }], pageParams: [null] }
  }

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
    (data) => upsertMessagePage(data, message, conversationId),
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
    (data) =>
      messages.reduce(
        (current, message) => upsertMessagePage(current, message, conversationId),
        data,
      ),
  )
}

/**
 * 重连时只补最新一页：用服务端最新页整体替换本地页集合，
 * 不重拉用户已经加载的更早分页。
 */
export async function refreshNewestMessages(
  queryClient: QueryClient,
  ownerId: string,
  conversationId: string,
): Promise<void> {
  const page = await fetchMessagePage(conversationId)
  // 先取消在途的向上分页：infinite query 完成时会把发起时的旧页整体写回，
  // 若与本次“最新页替换”交错，会把断线窗口的新消息覆盖掉。
  await queryClient.cancelQueries({ queryKey: chatKeys.messages(ownerId, conversationId) })
  // 用服务端最新页替换本地页集合：保留服务端 nextCursor，避免断线窗口留下
  // “中间一段永远翻不到”的历史缺口；空缓存时也由此建立初始 InfiniteData。
  queryClient.setQueryData<InfiniteData<MessageListResponse, string | null>>(
    chatKeys.messages(ownerId, conversationId),
    { pages: [page], pageParams: [null] },
  )
}

/** 重连收口：详情走一次强校验，消息只补最新一页，未读数强制探一次。 */
export async function refreshConversationOnReconnect(
  queryClient: QueryClient,
  ownerId: string,
  conversationId: string,
): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: chatKeys.conversation(ownerId, conversationId) })
  const [history, unread] = await Promise.allSettled([
    refreshNewestMessages(queryClient, ownerId, conversationId),
    queryClient.fetchQuery({
      queryKey: chatKeys.unreadCount(ownerId),
      queryFn: fetchConversationUnreadCount,
      staleTime: 0,
    }),
  ])
  if (history.status === 'rejected') throw history.reason
  if (unread.status === 'rejected') throw unread.reason
}

/**
 * 断线时打一次受鉴权 HTTP 探针。
 *
 * WebSocket upgrade 401 在浏览器侧只表现为 onerror/onclose，无法从事件本身识别；
 * 用 unread-count 这个真实 query 触发 QueryCache 的全局 401 收口即可。
 */
export function probeChatSession(queryClient: QueryClient, ownerId: string): void {
  void queryClient
    .fetchQuery({
      queryKey: chatKeys.unreadCount(ownerId),
      queryFn: fetchConversationUnreadCount,
      staleTime: 0,
    })
    .catch(() => undefined)
}

/**
 * 渲染用时间序：最新页在前，反转后按升序拼接；同一 id 只保留最新页的版本。
 *
 * 实时消息可能被临时塞进最新页，之后加载更早分页时服务端会再返回同一条，
 * 因此这里按 id 去重，避免同一 message 渲染两次（相同 React key）。
 */
export function flattenMessagePages<TPageParam>(
  data: InfiniteData<MessageListResponse, TPageParam> | undefined,
): MessageDto[] {
  if (!data) return []
  const byId = new Map<string, MessageDto>()
  for (const page of [...data.pages].reverse()) {
    for (const item of page.items) byId.set(item.id, item)
  }
  return [...byId.values()]
}

export function isMessageRead(message: MessageDto, counterpartLastReadAt: string | null): boolean {
  if (message.senderId === null || counterpartLastReadAt === null) return false
  return Date.parse(message.createdAt) <= Date.parse(counterpartLastReadAt)
}

/**
 * 读位只能单调前进：较旧的 HTTP 响应或 read 响应不能把已经收到的
 * `conversation.read` 覆盖回更早的值。
 */
export function mergeConversationReadMarker(
  current: ConversationDto | null | undefined,
  next: ConversationDto,
): ConversationDto {
  if (!current || current.id !== next.id || current.counterpartLastReadAt === null) return next
  if (
    next.counterpartLastReadAt !== null &&
    Date.parse(next.counterpartLastReadAt) >= Date.parse(current.counterpartLastReadAt)
  ) {
    return next
  }
  return { ...next, counterpartLastReadAt: current.counterpartLastReadAt }
}

/**
 * 会话 DTO 的单调合并：读位不后退，`lastMessageAt` 更旧的 HTTP/read 响应
 * 也不能把实时推送写入的较新预览与未读数覆盖掉。
 */
export function mergeConversationDto(
  current: ConversationDto | null | undefined,
  next: ConversationDto,
): ConversationDto {
  const merged = mergeConversationReadMarker(current, next)
  if (
    current &&
    current.id === next.id &&
    Date.parse(current.lastMessageAt) > Date.parse(next.lastMessageAt)
  ) {
    return {
      ...merged,
      lastMessage: current.lastMessage,
      lastMessageAt: current.lastMessageAt,
      unreadCount: current.unreadCount,
    }
  }
  return merged
}

export function updateConversationCaches(
  queryClient: QueryClient,
  ownerId: string,
  conversation: ConversationDto,
): void {
  const current = queryClient.getQueryData<ConversationDto | null>(
    chatKeys.conversation(ownerId, conversation.id),
  )
  const merged = mergeConversationDto(current, conversation)
  queryClient.setQueryData(chatKeys.conversation(ownerId, conversation.id), merged)
  queryClient.setQueryData<InfiniteData<ConversationListResponse, string | null>>(
    chatKeys.conversations(ownerId),
    (data) => updateConversationPage(data, merged),
  )
  // setQueryData 会清掉之前的 invalidate 标记；read 回写后重新标脏，
  // 保证回到列表时能重新取到最新的 lastMessage / unreadCount。
  void queryClient.invalidateQueries({ queryKey: chatKeys.conversations(ownerId) })
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

  // 事件到达时详情可能为空或有一次更旧的 HTTP 响应在飞；失效后由服务端
  // 重新确认读位，避免旧响应把已推进的已读状态覆盖回去。
  void queryClient.invalidateQueries({
    queryKey: chatKeys.conversation(ownerId, event.conversationId),
  })
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
