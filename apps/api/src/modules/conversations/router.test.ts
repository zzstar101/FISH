import { describe, expect, test } from 'bun:test'
import type { ConversationDto } from '@fish/contracts/chat/schema'
import { Hono } from 'hono'
import { createConversationsRouter } from './router'
import type { ConversationService } from './service'
import { ConversationServiceError } from './service'

const dto: ConversationDto = {
  id: '00000000-0000-4000-8000-0000000000c1',
  listingId: '00000000-0000-4000-8000-0000000000b1',
  role: 'buyer',
  listing: {
    id: '00000000-0000-4000-8000-0000000000b1',
    title: 'K380',
    priceCents: 16000,
    status: 'ACTIVE',
    coverUrl: null,
  },
  counterpart: {
    id: '00000000-0000-4000-8000-0000000000a2',
    nickname: '卖家',
    avatarUrl: null,
  },
  unreadCount: 0,
  lastMessage: {
    type: 'TEXT',
    content: '在吗',
    senderId: '00000000-0000-4000-8000-0000000000a2',
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
    }
    const app = buildApp(service)

    const first = await app.request('/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ listingId: '00000000-0000-4000-8000-0000000000b1' }),
    })
    expect(first.status).toBe(201)
    expect(await first.json()).toEqual(dto)

    created = false
    const second = await app.request('/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ listingId: '00000000-0000-4000-8000-0000000000b1' }),
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
    }
    const app = buildApp(service)
    const response = await app.request('/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ listingId: '00000000-0000-4000-8000-0000000000b1' }),
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
    }
    const app = buildApp(service)
    const response = await app.request('/conversations/conversation-1')
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
    }
    const app = buildApp(service)
    const response = await app.request('/conversations/secret')
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
    }
    const app = buildApp(service)
    const response = await app.request('/conversations/xxx/read', { method: 'POST' })
    expect(response.status).toBe(200)
    const body = (await response.json()) as ConversationDto
    expect(body.unreadCount).toBe(0)
  })
})
