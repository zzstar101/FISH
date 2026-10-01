import { describe, expect, test } from 'bun:test'
import type { Me } from '@fish/contracts/auth/user'
import type {
  ConversationDto,
  ConversationListResponse,
  MediaListResponse,
  MediaMessageDto,
  MessageDto,
  MessageListResponse,
} from '@fish/contracts/chat/schema'
import { QueryClient } from '@tanstack/react-query'
import { AUTH_ME_QUERY_KEY } from '../../lib/session-cache'
import {
  applyReadEventToCache,
  chatKeys,
  flattenMediaPages,
  flattenMessagePages,
  insertMediaIntoCache,
  insertMessageIntoCache,
  isMessageRead,
  mergeConversationDto,
  mergeConversationReadMarker,
  mergeMediaIntoCache,
  mergeMessagesIntoCache,
  refreshNewestMedia,
  refreshNewestMessages,
  updateConversationForOwner,
  updateConversationPage,
  upsertMediaPage,
  upsertMessagePage,
} from './queries'

const sender: NonNullable<MessageDto['sender']> = {
  id: 'usr_01jc000000e00800000000000a',
  nickname: '阿岚',
  avatarUrl: null,
}

function message(id: MessageDto['id'], createdAt: string, content: string = id): MessageDto {
  return {
    id,
    conversationId: 'cnv_01jc000000e00800000000001a',
    senderId: sender.id,
    sender,
    type: 'TEXT',
    content,
    recalledAt: null,
    replyTo: null,
    createdAt,
  }
}

function conversation(counterpartLastReadAt: string | null): ConversationDto {
  return {
    id: 'cnv_01jc000000e00800000000001a',
    listingId: 'lst_01jc000000e00800000000000t',
    role: 'buyer',
    listing: {
      id: 'lst_01jc000000e00800000000000t',
      title: '九成新自行车',
      priceCents: 12000,
      status: 'ACTIVE',
      coverUrl: null,
    },
    counterpart: { id: 'usr_01jc000000e00800000000000b', nickname: '小林', avatarUrl: null },
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

const CONVERSATION = 'cnv_01jc000000e00800000000001a'

function media(
  id: MediaMessageDto['id'],
  createdAt: string,
  kind: MediaMessageDto['kind'] = 'IMAGE',
): MediaMessageDto {
  return {
    id,
    conversationId: CONVERSATION,
    senderId: sender.id,
    kind,
    mediaId: 'med_01jc000000e00800000000002a',
    url: `/api/conversations/${CONVERSATION}/media/med_01jc000000e00800000000002a`,
    mimeType: kind === 'IMAGE' ? 'image/png' : 'audio/webm',
    sizeBytes: 1_024,
    width: kind === 'IMAGE' ? 1_200 : null,
    height: kind === 'IMAGE' ? 900 : null,
    durationMs: kind === 'VOICE' ? 2_000 : null,
    recalledAt: null,
    replyTo: null,
    createdAt,
  }
}

function mediaData(items: MediaMessageDto[]): {
  pages: MediaListResponse[]
  pageParams: Array<string | null>
} {
  return { pages: [{ items, nextCursor: null }], pageParams: [null] }
}

describe('message cache', () => {
  test('dedupes by server id and replaces the existing row', () => {
    const data = messageData([
      message('msg_01jc000000e00800000000001v', '2026-01-01T00:00:00.000Z'),
      message('msg_01jc000000e00800000000001w', '2026-01-01T00:00:01.000Z'),
    ])
    const next = upsertMessagePage(
      data,
      message('msg_01jc000000e00800000000001v', '2026-01-01T00:00:00.000Z', 'updated'),
      'cnv_01jc000000e00800000000001a',
    )

    expect(next?.pages[0]?.items.map((item) => item.id)).toEqual([
      'msg_01jc000000e00800000000001v',
      'msg_01jc000000e00800000000001w',
    ])
    expect(next?.pages[0]?.items[0]?.content).toBe('updated')
  })

  test('inserts a new message into the newest page and keeps ascending order', () => {
    const data = messageData([
      message('msg_01jc000000e00800000000001v', '2026-01-01T00:00:00.000Z'),
    ])
    const next = upsertMessagePage(
      data,
      message('msg_01jc000000e00800000000001w', '2026-01-01T00:00:02.000Z'),
      'cnv_01jc000000e00800000000001a',
    )

    expect(next?.pages[0]?.items.map((item) => item.id)).toEqual([
      'msg_01jc000000e00800000000001v',
      'msg_01jc000000e00800000000001w',
    ])
  })

  test('returns the same cache object when the message is already identical', () => {
    const existing = message('msg_01jc000000e00800000000001v', '2026-01-01T00:00:00.000Z')
    const data = messageData([existing])

    expect(upsertMessagePage(data, existing, 'cnv_01jc000000e00800000000001a')).toBe(data)
  })

  test('replaces a LISTING message when only the listing projection changed', () => {
    // 商品被下架 / 改价后重新拉到的那条：除 `listing` 外逐字段相同 —— 判成 identical
    // 会让屏幕上一直留着旧卡片状态（#359 3a 审查回合）。
    const base: MessageDto = {
      ...message('msg_01jc000000e00800000000001v', '2026-01-01T00:00:00.000Z'),
      type: 'LISTING',
      content: 'lst_01jc000000e00800000000000t',
    }
    const card: NonNullable<MessageDto['listing']> = {
      id: 'lst_01jc000000e00800000000000t',
      title: '九成新自行车',
      priceCents: 12000,
      status: 'ACTIVE',
      coverUrl: null,
    }
    const data = messageData([{ ...base, listing: card }])
    const sold: MessageDto = { ...base, listing: { ...card, status: 'SOLD' } }

    const next = upsertMessagePage(data, sold, 'cnv_01jc000000e00800000000001a')

    expect(next).not.toBe(data)
    expect(next?.pages[0]?.items[0]?.listing?.status).toBe('SOLD')
  })

  test('rejects a message that belongs to another conversation', () => {
    const data = messageData([
      message('msg_01jc000000e00800000000001v', '2026-01-01T00:00:00.000Z'),
    ])
    const foreign: MessageDto = {
      ...message('msg_01jc000000e00800000000001w', '2026-01-01T00:00:02.000Z'),
      conversationId: 'cnv_01jc000000e00800000000001b',
    }

    expect(upsertMessagePage(data, foreign, 'cnv_01jc000000e00800000000001a')).toBe(data)
  })

  test('seeds a message cache when none exists', () => {
    const queryClient = new QueryClient()
    insertMessageIntoCache(
      queryClient,
      'me',
      'cnv_01jc000000e00800000000001a',
      message('msg_01jc000000e00800000000001v', '2026-01-01T00:00:00.000Z'),
    )

    expect(
      queryClient
        .getQueryData<{ pages: MessageListResponse[] }>(
          chatKeys.messages('me', 'cnv_01jc000000e00800000000001a'),
        )
        ?.pages[0]?.items.map((item) => item.id),
    ).toEqual(['msg_01jc000000e00800000000001v'])
  })

  test('re-merges live messages after a pagination write', () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(
      chatKeys.messages('me', 'cnv_01jc000000e00800000000001a'),
      messageData([message('msg_01jc000000e00800000000001v', '2026-01-01T00:00:00.000Z')]),
    )

    mergeMessagesIntoCache(queryClient, 'me', 'cnv_01jc000000e00800000000001a', [
      message('msg_01jc000000e00800000000001w', '2026-01-01T00:00:02.000Z'),
    ])

    expect(
      queryClient
        .getQueryData<{ pages: MessageListResponse[] }>(
          chatKeys.messages('me', 'cnv_01jc000000e00800000000001a'),
        )
        ?.pages[0]?.items.map((item) => item.id),
    ).toEqual(['msg_01jc000000e00800000000001v', 'msg_01jc000000e00800000000001w'])
  })

  test('replaces loaded pages with the newest page on reconnect', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          items: [message('msg_01jc000000e00800000000001w', '2026-01-01T00:00:02.000Z')],
          nextCursor: 'msg_01jc000000e00800000000001w',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch
    try {
      const queryClient = new QueryClient()
      queryClient.setQueryData(
        chatKeys.messages('me', 'cnv_01jc000000e00800000000001a'),
        messageData([message('msg_01jc000000e00800000000001v', '2026-01-01T00:00:00.000Z')]),
      )

      await refreshNewestMessages(queryClient, 'me', 'cnv_01jc000000e00800000000001a')

      const data = queryClient.getQueryData<{
        pages: MessageListResponse[]
        pageParams: Array<string | null>
      }>(chatKeys.messages('me', 'cnv_01jc000000e00800000000001a'))
      expect(data?.pages).toHaveLength(1)
      expect(data?.pages[0]?.items.map((item) => item.id)).toEqual([
        'msg_01jc000000e00800000000001w',
      ])
      expect(data?.pages[0]?.nextCursor).toBe('msg_01jc000000e00800000000001w')
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
          items: [message('msg_01jc000000e00800000000001w', '2026-01-01T00:00:02.000Z')],
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
        queryKey: chatKeys.messages('me', 'cnv_01jc000000e00800000000001a'),
        queryFn: () => oldPage,
        initialPageParam: null as string | null,
        getNextPageParam: () => undefined,
      })

      await refreshNewestMessages(queryClient, 'me', 'cnv_01jc000000e00800000000001a')
      resolveOld({
        items: [message('msg_01jc000000e00800000000001v', '2026-01-01T00:00:00.000Z')],
        nextCursor: null,
      })
      await inFlight.catch(() => undefined)

      expect(
        queryClient
          .getQueryData<{ pages: MessageListResponse[] }>(
            chatKeys.messages('me', 'cnv_01jc000000e00800000000001a'),
          )
          ?.pages[0]?.items.map((item) => item.id),
      ).toEqual(['msg_01jc000000e00800000000001w'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('seeds an empty message cache from the newest page', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          items: [message('msg_01jc000000e00800000000001w', '2026-01-01T00:00:02.000Z')],
          nextCursor: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch
    try {
      const queryClient = new QueryClient()
      await refreshNewestMessages(queryClient, 'me', 'cnv_01jc000000e00800000000001a')

      expect(
        queryClient
          .getQueryData<{ pages: MessageListResponse[] }>(
            chatKeys.messages('me', 'cnv_01jc000000e00800000000001a'),
          )
          ?.pages[0]?.items.map((item) => item.id),
      ).toEqual(['msg_01jc000000e00800000000001w'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('flattens older pages before the newest page', () => {
    const older: MessageListResponse = {
      items: [message('msg_01jc000000e00800000000001v', '2026-01-01T00:00:00.000Z')],
      nextCursor: 'msg_01jc000000e00800000000001v',
    }
    const newest: MessageListResponse = {
      items: [message('msg_01jc000000e00800000000001w', '2026-01-01T00:00:01.000Z')],
      nextCursor: null,
    }
    const data = { pages: [newest, older], pageParams: [null, 'msg_01jc000000e00800000000001v'] }

    expect(flattenMessagePages(data).map((item) => item.id)).toEqual([
      'msg_01jc000000e00800000000001v',
      'msg_01jc000000e00800000000001w',
    ])
  })

  test('renders a message id once when a stale live message repeats in an older page', () => {
    // 重连只补最新页（m3）后，比它更旧的实时消息 m1 仍可能被并回最新页；
    // 之后加载更早分页时服务端会再次返回 m1 —— 渲染层必须按 id 去重。
    const newest: MessageListResponse = {
      items: [
        message('msg_01jc000000e00800000000001v', '2026-01-01T00:00:00.000Z'),
        message('msg_01jc000000e00800000000001x', '2026-01-01T00:00:02.000Z'),
      ],
      nextCursor: 'msg_01jc000000e00800000000001x',
    }
    const older: MessageListResponse = {
      items: [
        message('msg_01jc000000e00800000000001v', '2026-01-01T00:00:00.000Z'),
        message('msg_01jc000000e00800000000001w', '2026-01-01T00:00:01.000Z'),
      ],
      nextCursor: null,
    }
    const data = { pages: [newest, older], pageParams: [null, 'msg_01jc000000e00800000000001x'] }

    expect(flattenMessagePages(data).map((item) => item.id)).toEqual([
      'msg_01jc000000e00800000000001v',
      'msg_01jc000000e00800000000001w',
      'msg_01jc000000e00800000000001x',
    ])
  })
})

describe('conversation list cache', () => {
  test('does not write a late conversation into another account cache', () => {
    const queryClient = new QueryClient()
    const ownerA: Me = {
      id: 'usr_01jc000000e00800000000000d',
      nickname: '甲',
      avatarUrl: null,
      authStatus: 'UNVERIFIED',
      verifiedAt: null,
      phoneBound: false,
      maskedPhone: null,
      signature: null,
    }
    const ownerB: Me = { ...ownerA, id: 'usr_01jc000000e00800000000000e', nickname: '乙' }
    queryClient.setQueryData(AUTH_ME_QUERY_KEY, ownerA)

    expect(updateConversationForOwner(queryClient, ownerA.id, conversation(null))).toBe(true)
    expect(
      queryClient.getQueryData(chatKeys.conversation(ownerA.id, 'cnv_01jc000000e00800000000001a')),
    ).toBeDefined()

    queryClient.setQueryData(AUTH_ME_QUERY_KEY, ownerB)
    expect(updateConversationForOwner(queryClient, ownerA.id, conversation(null))).toBe(false)
    expect(
      queryClient.getQueryData(chatKeys.conversation(ownerB.id, 'cnv_01jc000000e00800000000001a')),
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

    const missing: ConversationDto = { ...existing, id: 'cnv_01jc000000e00800000000001b' }
    expect(updateConversationPage(data, missing)).toBe(data)
  })
})

describe('read receipt cache', () => {
  test('only counterpart read events advance the read marker', () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(
      chatKeys.conversation('me', 'cnv_01jc000000e00800000000001a'),
      conversation(null),
    )
    queryClient.setQueryData(chatKeys.conversations('me'), {
      pages: [{ items: [conversation(null)], nextCursor: null }],
      pageParams: [null],
    })

    applyReadEventToCache(queryClient, 'me', {
      conversationId: 'cnv_01jc000000e00800000000001a',
      readerId: 'usr_01jc000000e00800000000000b',
      readAt: '2026-01-01T00:00:05.000Z',
    })

    expect(
      queryClient.getQueryData<ConversationDto>(
        chatKeys.conversation('me', 'cnv_01jc000000e00800000000001a'),
      )?.counterpartLastReadAt,
    ).toBe('2026-01-01T00:00:05.000Z')
    expect(
      queryClient.getQueryData<{ pages: ConversationListResponse[] }>(chatKeys.conversations('me'))
        ?.pages[0]?.items[0]?.counterpartLastReadAt,
    ).toBe('2026-01-01T00:00:05.000Z')

    applyReadEventToCache(queryClient, 'me', {
      conversationId: 'cnv_01jc000000e00800000000001a',
      readerId: 'me',
      readAt: '2026-01-01T00:00:06.000Z',
    })

    expect(
      queryClient.getQueryData<ConversationDto>(
        chatKeys.conversation('me', 'cnv_01jc000000e00800000000001a'),
      )?.counterpartLastReadAt,
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
    const current: ConversationDto = {
      ...conversation(null),
      lastMessageAt: '2026-01-01T00:00:05.000Z',
      lastMessage: {
        type: 'TEXT' as const,
        content: '新的实时消息',
        senderId: 'usr_01jc000000e00800000000000b',
        createdAt: '2026-01-01T00:00:05.000Z',
      },
    }
    const older: ConversationDto = {
      ...conversation(null),
      lastMessageAt: '2026-01-01T00:00:00.000Z',
      lastMessage: {
        type: 'TEXT' as const,
        content: '旧的 HTTP 响应',
        senderId: 'usr_01jc000000e00800000000000b',
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
      isMessageRead(
        message('msg_01jc000000e00800000000001v', '2026-01-01T00:00:00.000Z'),
        '2026-01-01T00:00:00.000Z',
      ),
    ).toBe(true)
    expect(
      isMessageRead(
        message('msg_01jc000000e00800000000001v', '2026-01-01T00:00:01.000Z'),
        '2026-01-01T00:00:00.000Z',
      ),
    ).toBe(false)
    expect(
      isMessageRead(message('msg_01jc000000e00800000000001v', '2026-01-01T00:00:00.000Z'), null),
    ).toBe(false)
  })
})

describe('media cache', () => {
  test('dedupes media by server id and replaces the existing row', () => {
    const data = mediaData([
      media('msg_01jc000000e00800000000001v', '2026-01-01T00:00:00.000Z'),
      media('msg_01jc000000e00800000000001w', '2026-01-01T00:00:01.000Z'),
    ])
    const next = upsertMediaPage(
      data,
      { ...media('msg_01jc000000e00800000000001v', '2026-01-01T00:00:00.000Z'), sizeBytes: 9_999 },
      CONVERSATION,
    )

    expect(next?.pages[0]?.items.map((item) => item.id)).toEqual([
      'msg_01jc000000e00800000000001v',
      'msg_01jc000000e00800000000001w',
    ])
    expect(next?.pages[0]?.items[0]?.sizeBytes).toBe(9_999)
  })

  test('returns the same cache object when the media is already identical', () => {
    const existing = media('msg_01jc000000e00800000000001v', '2026-01-01T00:00:00.000Z')
    const data = mediaData([existing])

    expect(upsertMediaPage(data, existing, CONVERSATION)).toBe(data)
  })

  test('inserts new media into the newest page and keeps ascending order', () => {
    const data = mediaData([media('msg_01jc000000e00800000000001v', '2026-01-01T00:00:00.000Z')])
    const next = upsertMediaPage(
      data,
      media('msg_01jc000000e00800000000001w', '2026-01-01T00:00:02.000Z', 'VOICE'),
      CONVERSATION,
    )

    expect(next?.pages[0]?.items.map((item) => item.id)).toEqual([
      'msg_01jc000000e00800000000001v',
      'msg_01jc000000e00800000000001w',
    ])
  })

  test('rejects media that belongs to another conversation', () => {
    const data = mediaData([media('msg_01jc000000e00800000000001v', '2026-01-01T00:00:00.000Z')])
    const foreign: MediaMessageDto = {
      ...media('msg_01jc000000e00800000000001w', '2026-01-01T00:00:02.000Z'),
      conversationId: 'cnv_01jc000000e00800000000001b',
    }

    expect(upsertMediaPage(data, foreign, CONVERSATION)).toBe(data)
  })

  test('seeds a media cache when none exists', () => {
    const queryClient = new QueryClient()
    insertMediaIntoCache(
      queryClient,
      'me',
      CONVERSATION,
      media('msg_01jc000000e00800000000001v', '2026-01-01T00:00:00.000Z'),
    )

    expect(
      queryClient
        .getQueryData<{ pages: MediaListResponse[] }>(chatKeys.media('me', CONVERSATION))
        ?.pages[0]?.items.map((item) => item.id),
    ).toEqual(['msg_01jc000000e00800000000001v'])
  })

  test('re-merges live media after a pagination write', () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(
      chatKeys.media('me', CONVERSATION),
      mediaData([media('msg_01jc000000e00800000000001v', '2026-01-01T00:00:00.000Z')]),
    )

    mergeMediaIntoCache(queryClient, 'me', CONVERSATION, [
      media('msg_01jc000000e00800000000001w', '2026-01-01T00:00:02.000Z'),
      // 实时与发送响应同时到达的同一 id 只落一条。
      media('msg_01jc000000e00800000000001w', '2026-01-01T00:00:02.000Z'),
    ])

    expect(
      queryClient
        .getQueryData<{ pages: MediaListResponse[] }>(chatKeys.media('me', CONVERSATION))
        ?.pages[0]?.items.map((item) => item.id),
    ).toEqual(['msg_01jc000000e00800000000001v', 'msg_01jc000000e00800000000001w'])
  })

  test('flattens older media pages before the newest page and dedupes ids', () => {
    const older: MediaListResponse = {
      items: [media('msg_01jc000000e00800000000001v', '2026-01-01T00:00:00.000Z')],
      nextCursor: 'msg_01jc000000e00800000000001v',
    }
    const newest: MediaListResponse = {
      items: [
        media('msg_01jc000000e00800000000001w', '2026-01-01T00:00:02.000Z', 'VOICE'),
        // 分页时服务端会重发已实时落过的那条，按 id 只保留一份。
        media('msg_01jc000000e00800000000001v', '2026-01-01T00:00:00.000Z'),
      ],
      nextCursor: null,
    }

    expect(
      flattenMediaPages({
        pages: [newest, older],
        pageParams: [null, 'msg_01jc000000e00800000000001v'],
      }).map((item) => item.id),
    ).toEqual(['msg_01jc000000e00800000000001v', 'msg_01jc000000e00800000000001w'])
    expect(flattenMediaPages(undefined)).toEqual([])
  })

  test('replaces loaded media pages with the newest page on reconnect', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          items: [media('msg_01jc000000e00800000000001w', '2026-01-01T00:00:02.000Z', 'VOICE')],
          nextCursor: 'msg_01jc000000e00800000000001w',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch
    try {
      const queryClient = new QueryClient()
      queryClient.setQueryData(
        chatKeys.media('me', CONVERSATION),
        mediaData([media('msg_01jc000000e00800000000001v', '2026-01-01T00:00:00.000Z')]),
      )

      await refreshNewestMedia(queryClient, 'me', CONVERSATION)

      const data = queryClient.getQueryData<{
        pages: MediaListResponse[]
        pageParams: Array<string | null>
      }>(chatKeys.media('me', CONVERSATION))
      expect(data?.pages).toHaveLength(1)
      expect(data?.pages[0]?.items.map((item) => item.id)).toEqual([
        'msg_01jc000000e00800000000001w',
      ])
      expect(data?.pages[0]?.nextCursor).toBe('msg_01jc000000e00800000000001w')
      expect(data?.pageParams).toEqual([null])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
