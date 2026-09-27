import { describe, expect, test } from 'bun:test'
import { ApiError } from '../../lib/api-client'
import {
  conversationListPath,
  createConversation,
  describeCreateConversationFailure,
  describeSendFailure,
  isConversationNotFound,
  messageListPath,
} from './api'

describe('chat api paths', () => {
  test('conversation list always sends the contract limit and optional cursor', () => {
    expect(conversationListPath()).toBe('/conversations?limit=50')
    expect(conversationListPath('abc+/=')).toBe('/conversations?limit=50&cursor=abc%2B%2F%3D')
  })

  test('message list always sends the contract limit and optional before cursor', () => {
    expect(messageListPath('cnv_01jc000000e00800000000001a')).toBe(
      '/conversations/cnv_01jc000000e00800000000001a/messages?limit=100',
    )
    expect(
      messageListPath('cnv_01jc000000e00800000000001a', 'msg_01jc000000e00800000000001t'),
    ).toBe(
      '/conversations/cnv_01jc000000e00800000000001a/messages?limit=100&before=msg_01jc000000e00800000000001t',
    )
  })
})

describe('chat error helpers', () => {
  test('detects the unified conversation-not-found error', () => {
    expect(isConversationNotFound(new ApiError('CONVERSATION_NOT_FOUND', 404, '会话不存在'))).toBe(
      true,
    )
    expect(isConversationNotFound(new ApiError('INTERNAL_ERROR', 500, '请求失败'))).toBe(false)
    expect(isConversationNotFound(new Error('network'))).toBe(false)
  })

  test('describes conversation-create failures', () => {
    expect(
      describeCreateConversationFailure(new ApiError('LISTING_NOT_FOUND', 404, 'missing')),
    ).toBe('商品不存在或已下架')
    expect(describeCreateConversationFailure(new Error('network'))).toBe('发起会话失败，请重试')
  })

  test('creates a conversation with only the listing id', async () => {
    const originalFetch = globalThis.fetch
    let requestBody: unknown
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body))
      return new Response(
        JSON.stringify({
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
          unreadCount: 0,
          counterpartLastReadAt: null,
          lastMessage: null,
          lastMessageAt: '2026-01-01T00:00:00.000Z',
          createdAt: '2026-01-01T00:00:00.000Z',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    try {
      const conversation = await createConversation('lst_01jc000000e00800000000000t')
      expect(requestBody).toEqual({ listingId: 'lst_01jc000000e00800000000000t' })
      expect(conversation.id).toBe('cnv_01jc000000e00800000000001a')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('describes idempotency reuse without pretending success', () => {
    expect(
      describeSendFailure(new ApiError('IDEMPOTENCY_KEY_REUSED', 409, '同一个 clientRequestId')),
    ).toBe('该次发送已用于其它内容')
    expect(describeSendFailure(new ApiError('CONVERSATION_NOT_FOUND', 404, '会话不存在'))).toBe(
      '会话不存在或不可访问',
    )
    expect(describeSendFailure(new Error('network'))).toBe('发送失败，请重试')
  })
})
