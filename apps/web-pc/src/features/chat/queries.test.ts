import { describe, expect, test } from 'bun:test'
import type { Me } from '@fish/contracts/auth/user'
import type {
  ConversationDto,
  ConversationListResponse,
  MessageDto,
  MessageListResponse,
} from '@fish/contracts/chat/schema'
import { QueryClient } from '@tanstack/react-query'
import { AUTH_ME_QUERY_KEY } from '../../lib/session-cache'
import {
  applyReadEventToCache,
  chatKeys,
  flattenMessagePages,
  insertMessageIntoCache,
  isMessageRead,
  mergeConversationDto,
  mergeConversationReadMarker,
  mergeMessagesIntoCache,
  refreshNewestMessages,
  updateConversationForOwner,
  updateConversationPage,
  upsertMessagePage,
} from './queries'

const sender = { id: 'user-a', nickname: '阿岚', avatarUrl: null }

function message(id: string, createdAt: string, content = id): MessageDto {
  return {
    id,
    conversationId: 'conversation-1',
    senderId: sender.id,
    sender,
    type: 'TEXT',
    content,
    createdAt,
  }
}

function conversation(counterpartLastReadAt: string | null): ConversationDto {
  return {
    id: 'conversation-1',
    listingId: 'listing-1',
    role: 'buyer',
    listing: {
      id: 'listing-1',
      title: '九成新自行车',
      priceCents: 12000,
      status: 'ACTIVE',
      coverUrl: null,
    },
    counterpart: { id: 'user-b', nickname: '小林', avatarUrl: null },
    unreadCount: 1,
    counterpartLastReadAt,
    lastMessage: null,
    lastMessageAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

function messageData(items: MessageDto[]): {
  pages: MessageListResponse[]
  pageParams: Array<string | null>
} {
  return { pages: [{ items, nextCursor: null }], pageParams: [null] }
}

describe('message cache', () => {
  test('dedupes by server id and replaces the existing row', () => {
    const data = messageData([
      message('m1', '2026-01-01T00:00:00.000Z'),
      message('m2', '2026-01-01T00:00:01.000Z'),
    ])
    const next = upsertMessagePage(
      data,
      message('m1', '2026-01-01T00:00:00.000Z', 'updated'),
      'conversation-1',
    )

    expect(next?.pages[0]?.items.map((item) => item.id)).toEqual(['m1', 'm2'])
    expect(next?.pages[0]?.items[0]?.content).toBe('updated')
  })

  test('inserts a new message into the newest page and keeps ascending order', () => {
    const data = messageData([message('m1', '2026-01-01T00:00:00.000Z')])
    const next = upsertMessagePage(
      data,
      message('m2', '2026-01-01T00:00:02.000Z'),
      'conversation-1',
    )

    expect(next?.pages[0]?.items.map((item) => item.id)).toEqual(['m1', 'm2'])
  })

  test('returns the same cache object when the message is already identical', () => {
    const existing = message('m1', '2026-01-01T00:00:00.000Z')
    const data = messageData([existing])

    expect(upsertMessagePage(data, existing, 'conversation-1')).toBe(data)
  })

  test('rejects a message that belongs to another conversation', () => {
    const data = messageData([message('m1', '2026-01-01T00:00:00.000Z')])
    const foreign = {
      ...message('m2', '2026-01-01T00:00:02.000Z'),
      conversationId: 'conversation-2',
    }

    expect(upsertMessagePage(data, foreign, 'conversation-1')).toBe(data)
  })

  test('seeds a message cache when none exists', () => {
    const queryClient = new QueryClient()
    insertMessageIntoCache(
      queryClient,
      'me',
      'conversation-1',
      message('m1', '2026-01-01T00:00:00.000Z'),
    )

    expect(
      queryClient
        .getQueryData<{ pages: MessageListResponse[] }>(chatKeys.messages('me', 'conversation-1'))
        ?.pages[0]?.items.map((item) => item.id),
    ).toEqual(['m1'])
  })

  test('re-merges live messages after a pagination write', () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(
      chatKeys.messages('me', 'conversation-1'),
      messageData([message('m1', '2026-01-01T00:00:00.000Z')]),
    )

    mergeMessagesIntoCache(queryClient, 'me', 'conversation-1', [
      message('m2', '2026-01-01T00:00:02.000Z'),
    ])

    expect(
      queryClient
        .getQueryData<{ pages: MessageListResponse[] }>(chatKeys.messages('me', 'conversation-1'))
        ?.pages[0]?.items.map((item) => item.id),
    ).toEqual(['m1', 'm2'])
  })

  test('replaces loaded pages with the newest page on reconnect', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          items: [message('m2', '2026-01-01T00:00:02.000Z')],
          nextCursor: 'm2',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch
    try {
      const queryClient = new QueryClient()
      queryClient.setQueryData(
        chatKeys.messages('me', 'conversation-1'),
        messageData([message('m1', '2026-01-01T00:00:00.000Z')]),
      )

      await refreshNewestMessages(queryClient, 'me', 'conversation-1')

      const data = queryClient.getQueryData<{
        pages: MessageListResponse[]
        pageParams: Array<string | null>
      }>(chatKeys.messages('me', 'conversation-1'))
      expect(data?.pages).toHaveLength(1)
      expect(data?.pages[0]?.items.map((item) => item.id)).toEqual(['m2'])
      expect(data?.pages[0]?.nextCursor).toBe('m2')
      expect(data?.pageParams).toEqual([null])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('cancels an in-flight history request before replacing pages', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          items: [message('m2', '2026-01-01T00:00:02.000Z')],
          nextCursor: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch
    try {
      const queryClient = new QueryClient()
      let resolveOld!: (value: MessageListResponse) => void
      const oldPage = new Promise<MessageListResponse>((resolve) => {
        resolveOld = resolve
      })
      const inFlight = queryClient.fetchInfiniteQuery({
        queryKey: chatKeys.messages('me', 'conversation-1'),
        queryFn: () => oldPage,
        initialPageParam: null as string | null,
        getNextPageParam: () => undefined,
      })

      await refreshNewestMessages(queryClient, 'me', 'conversation-1')
      resolveOld({ items: [message('m1', '2026-01-01T00:00:00.000Z')], nextCursor: null })
      await inFlight.catch(() => undefined)

      expect(
        queryClient
          .getQueryData<{ pages: MessageListResponse[] }>(chatKeys.messages('me', 'conversation-1'))
          ?.pages[0]?.items.map((item) => item.id),
      ).toEqual(['m2'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('seeds an empty message cache from the newest page', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          items: [message('m2', '2026-01-01T00:00:02.000Z')],
          nextCursor: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch
    try {
      const queryClient = new QueryClient()
      await refreshNewestMessages(queryClient, 'me', 'conversation-1')

      expect(
        queryClient
          .getQueryData<{ pages: MessageListResponse[] }>(chatKeys.messages('me', 'conversation-1'))
          ?.pages[0]?.items.map((item) => item.id),
      ).toEqual(['m2'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('flattens older pages before the newest page', () => {
    const older = { items: [message('m1', '2026-01-01T00:00:00.000Z')], nextCursor: 'm1' }
    const newest = { items: [message('m2', '2026-01-01T00:00:01.000Z')], nextCursor: null }
    const data = { pages: [newest, older], pageParams: [null, 'm1'] }

    expect(flattenMessagePages(data).map((item) => item.id)).toEqual(['m1', 'm2'])
  })

  test('renders a message id once when a stale live message repeats in an older page', () => {
    // 重连只补最新页（m3）后，比它更旧的实时消息 m1 仍可能被并回最新页；
    // 之后加载更早分页时服务端会再次返回 m1 —— 渲染层必须按 id 去重。
    const newest = {
      items: [message('m1', '2026-01-01T00:00:00.000Z'), message('m3', '2026-01-01T00:00:02.000Z')],
      nextCursor: 'm3',
    }
    const older = {
      items: [message('m1', '2026-01-01T00:00:00.000Z'), message('m2', '2026-01-01T00:00:01.000Z')],
      nextCursor: null,
    }
    const data = { pages: [newest, older], pageParams: [null, 'm3'] }

    expect(flattenMessagePages(data).map((item) => item.id)).toEqual(['m1', 'm2', 'm3'])
  })
})

describe('conversation list cache', () => {
  test('does not write a late conversation into another account cache', () => {
    const queryClient = new QueryClient()
    const ownerA = { id: 'owner-a' } as Me
    const ownerB = { id: 'owner-b' } as Me
    queryClient.setQueryData(AUTH_ME_QUERY_KEY, ownerA)

    expect(updateConversationForOwner(queryClient, ownerA.id, conversation(null))).toBe(true)
    expect(
      queryClient.getQueryData(chatKeys.conversation(ownerA.id, 'conversation-1')),
    ).toBeDefined()

    queryClient.setQueryData(AUTH_ME_QUERY_KEY, ownerB)
    expect(updateConversationForOwner(queryClient, ownerA.id, conversation(null))).toBe(false)
    expect(
      queryClient.getQueryData(chatKeys.conversation(ownerB.id, 'conversation-1')),
    ).toBeUndefined()
  })

  test('updates an existing row but never inserts a missing conversation', () => {
    const existing = conversation(null)
    const data = {
      pages: [{ items: [existing], nextCursor: null }],
      pageParams: [null],
    }
    const updated = { ...existing, unreadCount: 0 }
    const next = updateConversationPage(data, updated)
    expect(next?.pages[0]?.items[0]?.unreadCount).toBe(0)

    const missing = { ...existing, id: 'conversation-2' }
    expect(updateConversationPage(data, missing)).toBe(data)
  })
})

describe('read receipt cache', () => {
  test('only counterpart read events advance the read marker', () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(chatKeys.conversation('me', 'conversation-1'), conversation(null))
    queryClient.setQueryData(chatKeys.conversations('me'), {
      pages: [{ items: [conversation(null)], nextCursor: null }],
      pageParams: [null],
    })

    applyReadEventToCache(queryClient, 'me', {
      conversationId: 'conversation-1',
      readerId: 'user-b',
      readAt: '2026-01-01T00:00:05.000Z',
    })

    expect(
      queryClient.getQueryData<ConversationDto>(chatKeys.conversation('me', 'conversation-1'))
        ?.counterpartLastReadAt,
    ).toBe('2026-01-01T00:00:05.000Z')
    expect(
      queryClient.getQueryData<{ pages: ConversationListResponse[] }>(chatKeys.conversations('me'))
        ?.pages[0]?.items[0]?.counterpartLastReadAt,
    ).toBe('2026-01-01T00:00:05.000Z')

    applyReadEventToCache(queryClient, 'me', {
      conversationId: 'conversation-1',
      readerId: 'me',
      readAt: '2026-01-01T00:00:06.000Z',
    })

    expect(
      queryClient.getQueryData<ConversationDto>(chatKeys.conversation('me', 'conversation-1'))
        ?.counterpartLastReadAt,
    ).toBe('2026-01-01T00:00:05.000Z')
  })

  test('never lets a stale conversation DTO move the read marker backwards', () => {
    expect(
      mergeConversationReadMarker(
        conversation('2026-01-01T00:00:05.000Z'),
        conversation('2026-01-01T00:00:00.000Z'),
      ).counterpartLastReadAt,
    ).toBe('2026-01-01T00:00:05.000Z')
    expect(
      mergeConversationReadMarker(
        conversation('2026-01-01T00:00:00.000Z'),
        conversation('2026-01-01T00:00:05.000Z'),
      ).counterpartLastReadAt,
    ).toBe('2026-01-01T00:00:05.000Z')
  })

  test('does not let an older DTO replace a newer last message', () => {
    const current = {
      ...conversation(null),
      lastMessageAt: '2026-01-01T00:00:05.000Z',
      lastMessage: {
        type: 'TEXT' as const,
        content: '新的实时消息',
        senderId: 'user-b',
        createdAt: '2026-01-01T00:00:05.000Z',
      },
    }
    const older = {
      ...conversation(null),
      lastMessageAt: '2026-01-01T00:00:00.000Z',
      lastMessage: {
        type: 'TEXT' as const,
        content: '旧的 HTTP 响应',
        senderId: 'user-b',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    }

    const merged = mergeConversationDto(current, older)
    expect(merged.lastMessageAt).toBe('2026-01-01T00:00:05.000Z')
    expect(merged.lastMessage?.content).toBe('新的实时消息')
  })

  test('keeps the newer unread count when an older detail response arrives', () => {
    const current = {
      ...conversation(null),
      lastMessageAt: '2026-01-01T00:00:05.000Z',
      unreadCount: 2,
    }
    const older = {
      ...conversation(null),
      lastMessageAt: '2026-01-01T00:00:00.000Z',
      unreadCount: 0,
    }

    const merged = mergeConversationDto(current, older)
    expect(merged.lastMessageAt).toBe('2026-01-01T00:00:05.000Z')
    expect(merged.unreadCount).toBe(2)
  })

  test('compares message createdAt against the counterpart read marker', () => {
    expect(
      isMessageRead(message('m1', '2026-01-01T00:00:00.000Z'), '2026-01-01T00:00:00.000Z'),
    ).toBe(true)
    expect(
      isMessageRead(message('m1', '2026-01-01T00:00:01.000Z'), '2026-01-01T00:00:00.000Z'),
    ).toBe(false)
    expect(isMessageRead(message('m1', '2026-01-01T00:00:00.000Z'), null)).toBe(false)
  })
})
