import { describe, expect, test } from 'bun:test'
import type { ConversationDto } from '@fish/contracts/chat/schema'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'

const LISTING = '01930000-0000-7000-8000-0000000000b1'
const CONVERSATION = '01930000-0000-7000-8000-0000000000c1'
const SELLER = '01930000-0000-7000-8000-0000000000a2'

import { Hono } from 'hono'
import { allowRestrictionGuard } from '../governance/testing'
import { createConversationsRouter } from './router'
import type { ConversationService } from './service'
import { ConversationServiceError } from './service'

const dto: ConversationDto = {
  id: encodePublicId(PUBLIC_ID_PREFIX.conversation, CONVERSATION),
  listingId: encodePublicId(PUBLIC_ID_PREFIX.listing, LISTING),
  role: 'buyer',
  listing: {
    id: encodePublicId(PUBLIC_ID_PREFIX.listing, LISTING),
    title: 'K380',
    priceCents: 16000,
    status: 'ACTIVE',
    coverUrl: null,
  },
  counterpart: {
    id: encodePublicId(PUBLIC_ID_PREFIX.user, SELLER),
    nickname: '卖家',
    avatarUrl: null,
  },
  unreadCount: 0,
  counterpartLastReadAt: null,
  lastMessage: {
    type: 'TEXT',
    content: '在吗',
    senderId: encodePublicId(PUBLIC_ID_PREFIX.user, SELLER),
    createdAt: '2026-09-12T10:00:00.000Z',
  },
  lastMessageAt: '2026-09-12T10:00:00.000Z',
  createdAt: '2026-09-12T09:00:00.000Z',
}

function buildApp(service: ConversationService) {
  const root = new Hono<{ Variables: { userId: string } }>()
  root.use('/conversations/*', async (c, next) => {
    c.set('userId', 'user-1')
    await next()
  })
  root.route(
    '/conversations',
    createConversationsRouter({
      service,
      guard: allowRestrictionGuard,
      requireAuth: async (_c, next) => {
        await next()
      },
    }),
  )
  return root
}

describe('conversations router', () => {
  test('POST / returns 201 when created and 200 when reused', async () => {
    let created = true
    const service: ConversationService = {
      createOrGetConversation: async () => ({ conversation: dto, created }),
      listConversations: async () => ({ items: [], nextCursor: null }),
      getConversation: async () => dto,
      markRead: async () => dto,
      getUnreadCount: async () => ({ unreadCount: 0 }),
    }
    const app = buildApp(service)

    const first = await app.request('/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ listingId: dto.listingId }),
    })
    expect(first.status).toBe(201)
    expect(await first.json()).toEqual(dto)

    created = false
    const second = await app.request('/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ listingId: dto.listingId }),
    })
    expect(second.status).toBe(200)
  })

  test('POST / with a missing listingId returns 422 before the service', async () => {
    const service: ConversationService = {
      createOrGetConversation: async () => {
        throw new ConversationServiceError(409, 'CANNOT_CHAT_WITH_SELF', '不能和自己的商品建立会话')
      },
      listConversations: async () => ({ items: [], nextCursor: null }),
      getConversation: async () => dto,
      markRead: async () => dto,
      getUnreadCount: async () => ({ unreadCount: 0 }),
    }
    const app = buildApp(service)
    const response = await app.request('/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    // listingId 缺失 → 422 校验失败（在 service 之前）
    expect(response.status).toBe(422)
  })

  test('POST / with a 409 service error returns the error envelope', async () => {
    const service: ConversationService = {
      createOrGetConversation: async () => {
        throw new ConversationServiceError(409, 'CANNOT_CHAT_WITH_SELF', '不能和自己的商品建立会话')
      },
      listConversations: async () => ({ items: [], nextCursor: null }),
      getConversation: async () => dto,
      markRead: async () => dto,
      getUnreadCount: async () => ({ unreadCount: 0 }),
    }
    const app = buildApp(service)
    const response = await app.request('/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ listingId: dto.listingId }),
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: { code: 'CANNOT_CHAT_WITH_SELF', message: '不能和自己的商品建立会话' },
    })
  })

  test('GET /:id returns the conversation dto', async () => {
    const service: ConversationService = {
      createOrGetConversation: async () => ({ conversation: dto, created: true }),
      listConversations: async () => ({ items: [], nextCursor: null }),
      getConversation: async () => dto,
      markRead: async () => dto,
      getUnreadCount: async () => ({ unreadCount: 0 }),
    }
    const app = buildApp(service)
    const response = await app.request(`/conversations/${dto.id}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(dto)
  })

  test('GET /:id hides an unauthorized conversation as 404', async () => {
    const service: ConversationService = {
      createOrGetConversation: async () => ({ conversation: dto, created: true }),
      listConversations: async () => ({ items: [], nextCursor: null }),
      getConversation: async () => {
        throw new ConversationServiceError(404, 'CONVERSATION_NOT_FOUND', '会话不存在')
      },
      markRead: async () => dto,
      getUnreadCount: async () => ({ unreadCount: 0 }),
    }
    const app = buildApp(service)
    const response = await app.request(`/conversations/${dto.id}`)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: { code: 'CONVERSATION_NOT_FOUND', message: '会话不存在' },
    })
  })

  test('GET /:id rejects a malformed conversation id before the service', async () => {
    const service: ConversationService = {
      createOrGetConversation: async () => ({ conversation: dto, created: true }),
      listConversations: async () => ({ items: [], nextCursor: null }),
      getConversation: async () => dto,
      markRead: async () => dto,
      getUnreadCount: async () => ({ unreadCount: 0 }),
    }
    const app = buildApp(service)
    const response = await app.request('/conversations/not-a-uuid')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: { code: 'CONVERSATION_NOT_FOUND', message: '会话不存在' },
    })
  })

  test('POST /:id/read returns the updated conversation dto', async () => {
    const service: ConversationService = {
      createOrGetConversation: async () => ({ conversation: dto, created: true }),
      listConversations: async () => ({ items: [], nextCursor: null }),
      getConversation: async () => dto,
      markRead: async () => ({ ...dto, unreadCount: 0 }),
      getUnreadCount: async () => ({ unreadCount: 0 }),
    }
    const app = buildApp(service)
    const response = await app.request(`/conversations/${dto.id}/read`, { method: 'POST' })
    expect(response.status).toBe(200)
    const body = (await response.json()) as ConversationDto
    expect(body.unreadCount).toBe(0)
  })

  test('POST /:id/read rejects a malformed conversation id before the service', async () => {
    let markReadCalled = false
    const service: ConversationService = {
      createOrGetConversation: async () => ({ conversation: dto, created: true }),
      listConversations: async () => ({ items: [], nextCursor: null }),
      getConversation: async () => dto,
      markRead: async () => {
        markReadCalled = true
        return dto
      },
      getUnreadCount: async () => ({ unreadCount: 0 }),
    }
    const app = buildApp(service)
    const response = await app.request('/conversations/not-a-uuid/read', { method: 'POST' })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: { code: 'CONVERSATION_NOT_FOUND', message: '会话不存在' },
    })
    expect(markReadCalled).toBe(false)
  })

  test('GET /unread-count returns the aggregate and is not shadowed by /:id', async () => {
    // getConversation 一旦被调用就抛：`/unread-count` 若被 `/:id` 吃掉，本用例会直接失败。
    const service: ConversationService = {
      createOrGetConversation: async () => ({ conversation: dto, created: true }),
      listConversations: async () => ({ items: [], nextCursor: null }),
      getConversation: async () => {
        throw new Error('GET /unread-count 不应落到 GET /:id')
      },
      markRead: async () => dto,
      getUnreadCount: async () => ({ unreadCount: 7 }),
    }
    const app = buildApp(service)
    const response = await app.request('/conversations/unread-count')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ unreadCount: 7 })
  })
})
