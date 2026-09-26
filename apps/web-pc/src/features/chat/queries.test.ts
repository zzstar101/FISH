import { describe, expect, test } from 'bun:test'
import type {
  ConversationDto,
  ConversationListResponse,
  MessageDto,
  MessageListResponse,
} from '@fish/contracts/chat/schema'
import { QueryClient } from '@tanstack/react-query'
import {
  applyReadEventToCache,
  chatKeys,
  flattenMessagePages,
  isMessageRead,
  mergeMessagesIntoCache,
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
    const next = upsertMessagePage(data, message('m1', '2026-01-01T00:00:00.000Z', 'updated'))

    expect(next?.pages[0]?.items.map((item) => item.id)).toEqual(['m1', 'm2'])
    expect(next?.pages[0]?.items[0]?.content).toBe('updated')
  })

  test('inserts a new message into the newest page and keeps ascending order', () => {
    const data = messageData([message('m1', '2026-01-01T00:00:00.000Z')])
    const next = upsertMessagePage(data, message('m2', '2026-01-01T00:00:02.000Z'))

    expect(next?.pages[0]?.items.map((item) => item.id)).toEqual(['m1', 'm2'])
  })

  test('returns the same cache object when the message is already identical', () => {
    const existing = message('m1', '2026-01-01T00:00:00.000Z')
    const data = messageData([existing])

    expect(upsertMessagePage(data, existing)).toBe(data)
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

  test('flattens older pages before the newest page', () => {
    const older = { items: [message('m1', '2026-01-01T00:00:00.000Z')], nextCursor: 'm1' }
    const newest = { items: [message('m2', '2026-01-01T00:00:01.000Z')], nextCursor: null }
    const data = { pages: [newest, older], pageParams: [null, 'm1'] }

    expect(flattenMessagePages(data).map((item) => item.id)).toEqual(['m1', 'm2'])
  })
})

describe('conversation list cache', () => {
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
