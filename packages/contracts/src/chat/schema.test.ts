import { describe, expect, test } from 'bun:test'
import {
  ChatErrorCodeSchema,
  conversationCreateInputSchema,
  conversationDtoSchema,
  conversationListQuerySchema,
  messageDtoSchema,
  messageListQuerySchema,
  messageSendInputSchema,
  realtimeClientEventSchema,
  realtimeServerEventSchema,
} from './schema'

describe('conversationCreateInputSchema', () => {
  test('accepts a valid listingId', () => {
    const input = { listingId: '0d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f' }
    expect(conversationCreateInputSchema.parse(input)).toEqual(input)
  })

  test('rejects a non-uuid listingId', () => {
    expect(conversationCreateInputSchema.safeParse({ listingId: 'not-a-uuid' }).success).toBe(false)
  })

  test('rejects extra fields (strict)', () => {
    const input = { listingId: '0d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f', buyerId: 'x' }
    expect(conversationCreateInputSchema.safeParse(input).success).toBe(false)
  })
})

describe('messageSendInputSchema', () => {
  test('trims content', () => {
    expect(messageSendInputSchema.parse({ content: '  还在吗  ' }).content).toBe('还在吗')
  })

  test('rejects whitespace-only content', () => {
    expect(messageSendInputSchema.safeParse({ content: '   ' }).success).toBe(false)
  })

  test('rejects content over 2000 chars', () => {
    expect(messageSendInputSchema.safeParse({ content: 'a'.repeat(2001) }).success).toBe(false)
  })

  test('rejects extra fields (strict)', () => {
    expect(messageSendInputSchema.safeParse({ content: 'hi', type: 'TEXT' }).success).toBe(false)
  })
})

describe('conversationListQuerySchema', () => {
  test('applies limit default and coerces query strings', () => {
    expect(conversationListQuerySchema.parse({})).toEqual({ limit: 20 })
    expect(conversationListQuerySchema.parse({ limit: '5' })).toEqual({ limit: 5 })
  })

  test('rejects limit over 50 and a blank cursor', () => {
    expect(conversationListQuerySchema.safeParse({ limit: 51 }).success).toBe(false)
    expect(conversationListQuerySchema.safeParse({ cursor: '' }).success).toBe(false)
  })

  test('rejects offset-style params (strict)', () => {
    expect(conversationListQuerySchema.safeParse({ page: 2 }).success).toBe(false)
  })
})

describe('messageListQuerySchema', () => {
  test('applies limit default and coerces query strings', () => {
    expect(messageListQuerySchema.parse({})).toEqual({ limit: 30 })
    expect(messageListQuerySchema.parse({ limit: '10' })).toEqual({ limit: 10 })
  })

  test('rejects limit out of 1..100', () => {
    expect(messageListQuerySchema.safeParse({ limit: 0 }).success).toBe(false)
    expect(messageListQuerySchema.safeParse({ limit: 101 }).success).toBe(false)
  })

  test('rejects a non-uuid before cursor', () => {
    expect(messageListQuerySchema.safeParse({ before: 'nope' }).success).toBe(false)
  })
})

describe('messageDtoSchema', () => {
  const base = {
    id: '0d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f',
    conversationId: '1d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f',
    content: 'hello',
    createdAt: '2026-09-12T00:00:00.000Z',
  }

  test('parses a TEXT message with a sender', () => {
    const dto = {
      ...base,
      senderId: '2d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f',
      sender: { id: '2d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f', nickname: 'A', avatarUrl: null },
      type: 'TEXT',
    }
    expect(messageDtoSchema.parse(dto).type).toBe('TEXT')
  })

  test('rejects a TEXT message without a sender (DB CHECK 同源)', () => {
    const dto = { ...base, senderId: null, sender: null, type: 'TEXT' }
    expect(messageDtoSchema.safeParse(dto).success).toBe(false)
  })

  test('parses a SYSTEM message with null sender', () => {
    const dto = { ...base, senderId: null, sender: null, type: 'SYSTEM' }
    expect(messageDtoSchema.parse(dto).senderId).toBeNull()
  })
})

describe('conversationDtoSchema', () => {
  test('parses a full dto with nullable avatar/cover and iso dates', () => {
    const dto = {
      id: '3d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f',
      listingId: '4d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f',
      role: 'seller',
      listing: {
        id: '4d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f',
        title: 'K380 键盘',
        priceCents: 16000,
        status: 'ACTIVE',
        coverUrl: null,
      },
      counterpart: {
        id: '5d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f',
        nickname: '买家小明',
        avatarUrl: 'https://cdn.example.com/a.png',
      },
      unreadCount: 2,
      counterpartLastReadAt: '2026-09-12T09:30:00.000Z',
      lastMessage: {
        type: 'TEXT',
        content: '在吗，可以刀一点吗',
        senderId: '5d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f',
        createdAt: '2026-09-12T10:00:00.000Z',
      },
      lastMessageAt: '2026-09-12T10:00:00.000Z',
      createdAt: '2026-09-12T09:00:00.000Z',
    }
    const parsed = conversationDtoSchema.parse(dto)
    expect(parsed.role).toBe('seller')
    expect(parsed.listing.status).toBe('ACTIVE')
    expect(parsed.counterpart.avatarUrl).toBe('https://cdn.example.com/a.png')
    expect(parsed.counterpartLastReadAt).toBe('2026-09-12T09:30:00.000Z')
    expect(parsed.lastMessage?.type).toBe('TEXT')
  })

  test('parses a conversation with no messages yet (lastMessage null)', () => {
    const dto = {
      id: '3d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f',
      listingId: '4d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f',
      role: 'seller',
      listing: {
        id: '4d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f',
        title: 'K380 键盘',
        priceCents: 16000,
        status: 'ACTIVE',
        coverUrl: null,
      },
      counterpart: {
        id: '5d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f',
        nickname: '买家小明',
        avatarUrl: null,
      },
      unreadCount: 0,
      counterpartLastReadAt: null,
      lastMessage: null,
      lastMessageAt: '2026-09-12T10:00:00.000Z',
      createdAt: '2026-09-12T09:00:00.000Z',
    }
    // 对方从未读过：null 是合法值（不是「字段缺失」），页面据此不渲染任何「已读」
    expect(conversationDtoSchema.parse(dto).counterpartLastReadAt).toBeNull()
    expect(conversationDtoSchema.parse(dto).lastMessage).toBeNull()
  })

  test('rejects an unknown role or listing status', () => {
    const base = {
      id: '3d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f',
      listingId: '4d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f',
      listing: {
        id: '4d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f',
        title: 'K380 键盘',
        priceCents: 16000,
        status: 'ACTIVE',
        coverUrl: null,
      },
      counterpart: {
        id: '5d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f',
        nickname: '买家小明',
        avatarUrl: null,
      },
      unreadCount: 0,
      counterpartLastReadAt: null,
      lastMessage: null,
      lastMessageAt: '2026-09-12T10:00:00.000Z',
      createdAt: '2026-09-12T09:00:00.000Z',
    }
    expect(conversationDtoSchema.safeParse({ ...base, role: 'admin' }).success).toBe(false)
    expect(
      conversationDtoSchema.safeParse({ ...base, listing: { ...base.listing, status: 'GONE' } })
        .success,
    ).toBe(false)
    expect(
      conversationDtoSchema.safeParse({
        ...base,
        lastMessage: {
          type: 'EMAIL',
          content: 'hi',
          senderId: null,
          createdAt: '2026-09-12T10:00:00.000Z',
        },
      }).success,
    ).toBe(false)
    // `counterpartLastReadAt` 可空但**不可缺**：老服务端漏字段时在此炸掉，而不是让
    // 前端把「对方没读过」与「服务端没说」当成同一件事。
    expect(
      conversationDtoSchema.safeParse({ ...base, counterpartLastReadAt: undefined }).success,
    ).toBe(false)
  })
})

describe('realtime events', () => {
  test('discriminates message.new server events', () => {
    const event = {
      type: 'message.new',
      conversationId: '1d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f',
      message: {
        id: '0d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f',
        conversationId: '1d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f',
        senderId: null,
        sender: null,
        type: 'SYSTEM',
        content: 'hi',
        createdAt: '2026-09-12T00:00:00.000Z',
      },
    }
    expect(realtimeServerEventSchema.parse(event).type).toBe('message.new')
  })

  test('accepts ping/pong keepalive pair and rejects unknown types', () => {
    expect(realtimeClientEventSchema.parse({ type: 'ping' }).type).toBe('ping')
    expect(realtimeServerEventSchema.parse({ type: 'pong' }).type).toBe('pong')
    expect(realtimeServerEventSchema.safeParse({ type: 'typing' }).success).toBe(false)
    expect(realtimeClientEventSchema.safeParse({ type: 'pong' }).success).toBe(false)
  })

  test('discriminates conversation.read with server-authoritative readAt', () => {
    const parsed = realtimeServerEventSchema.parse({
      type: 'conversation.read',
      conversationId: '1d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f',
      readerId: '2d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f',
      readAt: '2026-09-12T10:05:00.000Z',
    })
    expect(parsed.type).toBe('conversation.read')
    // readAt / readerId 都是必填：少了就分不清「谁读的、读到哪」，客户端无法安全翻转已读
    expect(
      realtimeServerEventSchema.safeParse({
        type: 'conversation.read',
        conversationId: '1d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f',
      }).success,
    ).toBe(false)
  })
})

describe('ChatErrorCodeSchema', () => {
  test('rejects an unknown code', () => {
    expect(ChatErrorCodeSchema.safeParse('SOME_OTHER_CODE').success).toBe(false)
  })
})
