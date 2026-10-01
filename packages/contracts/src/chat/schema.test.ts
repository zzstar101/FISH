import { describe, expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'

const ids = {
  listing: encodePublicId(PUBLIC_ID_PREFIX.listing, '01930000-0000-7000-8000-0000000000b1'),
  conversation: encodePublicId(
    PUBLIC_ID_PREFIX.conversation,
    '01930000-0000-7000-8000-0000000000c1',
  ),
  message: encodePublicId(PUBLIC_ID_PREFIX.message, '01930000-0000-7000-8000-0000000000d1'),
  user: encodePublicId(PUBLIC_ID_PREFIX.user, '01930000-0000-7000-8000-0000000000a1'),
}

import {
  ChatErrorCodeSchema,
  chatWatchersQuerySchema,
  chatWatchersResponseSchema,
  conversationCreateInputSchema,
  conversationDtoSchema,
  conversationLastMessageSchema,
  conversationListQuerySchema,
  imageMediaMessageInputSchema,
  listingMessageSendInputSchema,
  messageDtoSchema,
  messageListQuerySchema,
  messageSendBodySchema,
  messageSendInputSchema,
  messageTypeSchema,
  realtimeClientEventSchema,
  realtimeServerEventSchema,
  voiceMediaMessageInputSchema,
} from './schema'

describe('conversationCreateInputSchema', () => {
  test('accepts a valid listingId', () => {
    const input = { listingId: ids.listing }
    expect(conversationCreateInputSchema.parse(input)).toEqual(input)
  })

  test('rejects a non-uuid listingId', () => {
    expect(conversationCreateInputSchema.safeParse({ listingId: 'not-a-uuid' }).success).toBe(false)
  })

  test('rejects extra fields (strict)', () => {
    const input = { listingId: ids.listing, buyerId: 'x' }
    expect(conversationCreateInputSchema.safeParse(input).success).toBe(false)
  })
})

describe('chatWatchersSchema', () => {
  test('分页限额与窄字段列表；人数不受单页 limit 影响', () => {
    expect(chatWatchersQuerySchema.parse({})).toEqual({ limit: 20 })
    expect(chatWatchersQuerySchema.safeParse({ limit: 51 }).success).toBe(false)
    expect(chatWatchersQuerySchema.safeParse({ otherUserId: 'x' }).success).toBe(false)
    expect(chatWatchersResponseSchema.parse({ items: [], total: 35, nextCursor: null })).toEqual({
      items: [],
      total: 35,
      nextCursor: null,
    })
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

  test('rejects unknown extra fields (strict)', () => {
    expect(
      messageSendInputSchema.safeParse({ content: 'hi', listingId: ids.listing }).success,
    ).toBe(false)
    expect(messageSendInputSchema.safeParse({ content: 'hi', body: 'x' }).success).toBe(false)
  })

  // #359：TEXT 体可以显式带判别值（与 LISTING 体同风格），旧的无判别值形态继续可用。
  test('accepts an explicit type=TEXT discriminator', () => {
    expect(messageSendInputSchema.parse({ type: 'TEXT', content: 'hi' })).toEqual({
      type: 'TEXT',
      content: 'hi',
    })
  })

  test('rejects type=LISTING on the TEXT body', () => {
    expect(messageSendInputSchema.safeParse({ type: 'LISTING', content: 'hi' }).success).toBe(false)
  })

  test('accepts an optional uuid clientRequestId and omits it when absent', () => {
    const clientRequestId = '0d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f'
    expect(messageSendInputSchema.parse({ content: 'hi', clientRequestId })).toEqual({
      content: 'hi',
      clientRequestId,
    })
    expect(messageSendInputSchema.parse({ content: 'hi' }).clientRequestId).toBeUndefined()
  })

  test('rejects a non-uuid clientRequestId', () => {
    expect(
      messageSendInputSchema.safeParse({ content: 'hi', clientRequestId: 'req-1' }).success,
    ).toBe(false)
  })
})

describe('listingMessageSendInputSchema / messageSendBodySchema（#359 商品卡）', () => {
  test('accepts a listingId and an optional uuid clientRequestId', () => {
    const clientRequestId = '0d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f'
    expect(
      listingMessageSendInputSchema.parse({ type: 'LISTING', listingId: ids.listing }),
    ).toEqual({
      type: 'LISTING',
      listingId: ids.listing,
    })
    expect(
      messageSendBodySchema.parse({
        type: 'LISTING',
        listingId: ids.listing,
        clientRequestId,
      }),
    ).toEqual({ type: 'LISTING', listingId: ids.listing, clientRequestId })
  })

  test('rejects a LISTING body without listingId, a bad listingId, or extra fields', () => {
    expect(messageSendBodySchema.safeParse({ type: 'LISTING' }).success).toBe(false)
    expect(
      messageSendBodySchema.safeParse({ type: 'LISTING', listingId: 'not-a-public-id' }).success,
    ).toBe(false)
    expect(
      messageSendBodySchema.safeParse({ type: 'LISTING', listingId: ids.listing, content: 'x' })
        .success,
    ).toBe(false)
    expect(
      messageSendBodySchema.safeParse({ type: 'LISTING', listingId: ids.conversation }).success,
    ).toBe(false)
  })

  test('TEXT 与 LISTING 两种体都能过同一个联合（含旧的无判别值形态）', () => {
    expect(messageSendBodySchema.parse({ content: 'hi' })).toEqual({ content: 'hi' })
    expect(messageSendBodySchema.parse({ type: 'TEXT', content: 'hi' })).toEqual({
      type: 'TEXT',
      content: 'hi',
    })
    expect(messageSendBodySchema.parse({ type: 'LISTING', listingId: ids.listing })).toEqual({
      type: 'LISTING',
      listingId: ids.listing,
    })
    // 两者都不满足时（如空的枚举判别值）不被任一成员接受。
    expect(messageSendBodySchema.safeParse({ type: 'LISTING' }).success).toBe(false)
    expect(messageSendBodySchema.safeParse({}).success).toBe(false)
  })
})

describe('media message input schemas', () => {
  const image = {
    kind: 'IMAGE',
    objectKey: 'chat-media/1/2/a.webp',
    contentType: 'image/webp',
    sizeBytes: 1024,
    width: 800,
    height: 600,
  }
  const voice = {
    kind: 'VOICE',
    objectKey: 'chat-media/1/2/a.webm',
    contentType: 'audio/webm',
    sizeBytes: 2048,
    durationMs: 3000,
  }
  const clientRequestId = '0d7c1f28-2b0f-4a4e-9d1a-3f5b6c7d8e9f'

  test('accepts an optional uuid clientRequestId for both kinds', () => {
    expect(imageMediaMessageInputSchema.parse({ ...image, clientRequestId }).clientRequestId).toBe(
      clientRequestId,
    )
    expect(voiceMediaMessageInputSchema.parse({ ...voice, clientRequestId }).clientRequestId).toBe(
      clientRequestId,
    )
  })

  test('rejects a non-uuid clientRequestId', () => {
    expect(imageMediaMessageInputSchema.safeParse({ ...image, clientRequestId: 'x' }).success).toBe(
      false,
    )
    expect(voiceMediaMessageInputSchema.safeParse({ ...voice, clientRequestId: 'x' }).success).toBe(
      false,
    )
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
    id: ids.message,
    conversationId: ids.conversation,
    recalledAt: null,
    replyTo: null,
    content: 'hello',
    createdAt: '2026-09-12T00:00:00.000Z',
  }

  test('parses a TEXT message with a sender', () => {
    const dto = {
      ...base,
      senderId: ids.user,
      sender: { id: ids.user, nickname: 'A', avatarUrl: null },
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

  test('parses a LISTING message carrying the enriched listing projection（#359）', () => {
    const dto = {
      ...base,
      senderId: ids.user,
      sender: { id: ids.user, nickname: 'A', avatarUrl: null },
      type: 'LISTING',
      content: ids.listing,
      listing: {
        id: ids.listing,
        title: 'K380 键盘',
        priceCents: 16000,
        status: 'ACTIVE',
        coverUrl: null,
      },
    }
    const parsed = messageDtoSchema.parse(dto)
    expect(parsed.type).toBe('LISTING')
    expect(parsed.content).toBe(ids.listing)
    expect(parsed.listing?.title).toBe('K380 键盘')
  })

  test('listing 可缺省（老客户端 fixture）且可为 null；未知状态仍被拒', () => {
    const text = {
      ...base,
      senderId: ids.user,
      sender: { id: ids.user, nickname: 'A', avatarUrl: null },
      type: 'TEXT' as const,
    }
    // 缺省即 undefined（`.optional()`），与 null 同义：TEXT / SYSTEM 不携带商品投射。
    expect(messageDtoSchema.parse(text).listing).toBeUndefined()
    expect(messageDtoSchema.parse({ ...text, listing: null }).listing).toBeNull()
    expect(
      messageDtoSchema.safeParse({
        ...text,
        type: 'LISTING',
        listing: {
          id: ids.listing,
          title: 'x',
          priceCents: 1,
          status: 'DELETED',
          coverUrl: null,
        },
      }).success,
    ).toBe(false)
  })
})

describe('conversationDtoSchema', () => {
  /** #359 第五点：会话对面的在线态。`online` 恒非空对象，`lastActiveAt` 可空。 */
  const presence = { online: true, lastActiveAt: '2026-09-12T10:00:00.000Z' }

  test('parses a full dto with nullable avatar/cover and iso dates', () => {
    const dto = {
      id: ids.conversation,
      listingId: ids.listing,
      role: 'seller',
      listing: {
        id: ids.listing,
        title: 'K380 键盘',
        priceCents: 16000,
        status: 'ACTIVE',
        coverUrl: null,
      },
      counterpart: {
        id: ids.user,
        nickname: '买家小明',
        avatarUrl: 'https://cdn.example.com/a.png',
      },
      counterpartPresence: presence,
      unreadCount: 2,
      counterpartLastReadAt: '2026-09-12T09:30:00.000Z',
      lastMessage: {
        type: 'TEXT',
        content: '在吗，可以刀一点吗',
        senderId: ids.user,
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

  test('lastMessage 允许 MEDIA：媒体摘要不进 MessageDto，但会话行必须能显示（#67 第四步）', () => {
    const parsed = conversationLastMessageSchema.parse({
      type: 'MEDIA',
      content: '[图片]',
      senderId: ids.user,
      createdAt: '2026-09-12T10:00:00.000Z',
    })
    expect(parsed.type).toBe('MEDIA')
    expect(parsed.content).toBe('[图片]')
    // 媒体正文依然不进消息流：MessageDto 只认 TEXT/SYSTEM
    expect(messageTypeSchema.safeParse('MEDIA').success).toBe(false)
  })

  test('lastMessage 允许 LISTING：content 是服务端翻好的 `[商品]`（#359）', () => {
    const parsed = conversationLastMessageSchema.parse({
      type: 'LISTING',
      content: '[商品]',
      senderId: ids.user,
      createdAt: '2026-09-12T10:00:00.000Z',
    })
    expect(parsed.type).toBe('LISTING')
    expect(parsed.content).toBe('[商品]')
    // 商品卡的正文（公开 id）不进 messages 流以外的地方，也不该成为摘要文案。
    expect(messageTypeSchema.parse('LISTING')).toBe('LISTING')
  })

  test('parses a conversation with no messages yet (lastMessage null)', () => {
    const dto = {
      id: ids.conversation,
      listingId: ids.listing,
      role: 'seller',
      listing: {
        id: ids.listing,
        title: 'K380 键盘',
        priceCents: 16000,
        status: 'ACTIVE',
        coverUrl: null,
      },
      counterpart: {
        id: ids.user,
        nickname: '买家小明',
        avatarUrl: null,
      },
      counterpartPresence: presence,
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
      id: ids.conversation,
      listingId: ids.listing,
      listing: {
        id: ids.listing,
        title: 'K380 键盘',
        priceCents: 16000,
        status: 'ACTIVE',
        coverUrl: null,
      },
      counterpart: {
        id: ids.user,
        nickname: '买家小明',
        avatarUrl: null,
      },
      counterpartPresence: presence,
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
    // `counterpartPresence`（#359 第五点）同款：缺字段 = 老服务端，必须在解析处炸掉，
    // 而不是让端上把「拿不到在线态」画成「离线」。
    expect(
      conversationDtoSchema.safeParse({ ...base, counterpartPresence: undefined }).success,
    ).toBe(false)
    expect(
      conversationDtoSchema.safeParse({
        ...base,
        counterpartPresence: { online: true },
      }).success,
    ).toBe(false)
  })
})

describe('realtime events', () => {
  test('discriminates message.new server events', () => {
    const event = {
      type: 'message.new',
      conversationId: ids.conversation,
      message: {
        id: ids.message,
        conversationId: ids.conversation,
        senderId: null,
        sender: null,
        type: 'SYSTEM',
        content: 'hi',
        recalledAt: null,
        replyTo: null,
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
      conversationId: ids.conversation,
      readerId: ids.user,
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

  test('discriminates presence.changed（#359 第五点：推给对方，只推「变在线」）', () => {
    const parsed = realtimeServerEventSchema.parse({
      type: 'presence.changed',
      userId: ids.user,
      presence: { online: true, lastActiveAt: '2026-09-12T10:05:00.000Z' },
    })
    expect(parsed.type).toBe('presence.changed')
    expect(parsed.type === 'presence.changed' && parsed.presence.online).toBe(true)
    // userId 与 presence 都是必填：少了就不知道「谁的在线态变了 / 变成了什么」
    expect(realtimeServerEventSchema.safeParse({ type: 'presence.changed' }).success).toBe(false)
    expect(
      realtimeServerEventSchema.safeParse({
        type: 'presence.changed',
        userId: ids.user,
        presence: { online: 'yes' },
      }).success,
    ).toBe(false)
  })
})

describe('ChatErrorCodeSchema', () => {
  test('rejects an unknown code', () => {
    expect(ChatErrorCodeSchema.safeParse('SOME_OTHER_CODE').success).toBe(false)
  })

  test('accepts IDEMPOTENCY_KEY_REUSED（#67 同键不同内容的 409）', () => {
    expect(ChatErrorCodeSchema.parse('IDEMPOTENCY_KEY_REUSED')).toBe('IDEMPOTENCY_KEY_REUSED')
  })
})
