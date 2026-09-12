import { describe, expect, test } from 'bun:test'
import {
  ChatErrorCodeSchema,
  conversationCreateInputSchema,
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
  test('applies page/pageSize defaults and coerces query strings', () => {
    expect(conversationListQuerySchema.parse({})).toEqual({ page: 1, pageSize: 20 })
    expect(conversationListQuerySchema.parse({ page: '2', pageSize: '5' })).toEqual({
      page: 2,
      pageSize: 5,
    })
  })

  test('rejects pageSize over 50', () => {
    expect(conversationListQuerySchema.safeParse({ pageSize: 51 }).success).toBe(false)
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
      sender: { id: '2d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f', nickname: 'A' },
      type: 'TEXT',
    }
    expect(messageDtoSchema.parse(dto).type).toBe('TEXT')
  })

  test('parses a SYSTEM message with null sender', () => {
    const dto = { ...base, senderId: null, sender: null, type: 'SYSTEM' }
    expect(messageDtoSchema.parse(dto).senderId).toBeNull()
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
})

describe('ChatErrorCodeSchema', () => {
  test('rejects an unknown code', () => {
    expect(ChatErrorCodeSchema.safeParse('SOME_OTHER_CODE').success).toBe(false)
  })
})
