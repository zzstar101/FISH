import { describe, expect, test } from 'bun:test'
import type { MessageDto } from '@fish/contracts/chat/schema'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'

const CONVERSATION = '01930000-0000-7000-8000-0000000000c1'
const conversationPath = `/conversations/${encodePublicId(PUBLIC_ID_PREFIX.conversation, CONVERSATION)}/messages`
const sender = encodePublicId(PUBLIC_ID_PREFIX.user, '01930000-0000-7000-8000-0000000000a1')
const listingId = encodePublicId(PUBLIC_ID_PREFIX.listing, '01930000-0000-7000-8000-0000000000b1')

import { Hono } from 'hono'
import { allowRestrictionGuard } from '../governance/testing'
import { createMessagesRouter } from './router'
import { type MessageService, MessageServiceError } from './service'

const message: MessageDto = {
  id: encodePublicId(PUBLIC_ID_PREFIX.message, '01930000-0000-7000-8000-0000000000d1'),
  conversationId: encodePublicId(PUBLIC_ID_PREFIX.conversation, CONVERSATION),
  senderId: sender,
  sender: { id: sender, nickname: '买家', avatarUrl: null },
  type: 'TEXT',
  content: '还在吗',
  recalledAt: null,
  replyTo: null,
  createdAt: '2026-09-12T10:00:00.000Z',
}

const service: MessageService = {
  listMessages: async () => ({ items: [message], nextCursor: null }),
  sendTextMessage: async () => message,
  recallMessage: async () => undefined,
  sendListingMessage: async () => message,
}

function buildApp(overrides: Partial<MessageService> = {}) {
  const root = new Hono<{ Variables: { userId: string } }>()
  root.use('/conversations/*', async (c, next) => {
    c.set('userId', 'user-1')
    await next()
  })
  root.route(
    '/conversations',
    createMessagesRouter({
      service: { ...service, ...overrides },
      guard: allowRestrictionGuard,
      requireAuth: async (_c, next) => {
        await next()
      },
    }),
  )
  return root
}

describe('messages router', () => {
  test('GET /:id/messages returns the ascending page', async () => {
    const response = await buildApp().request(conversationPath)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { items: MessageDto[]; nextCursor: string | null }
    expect(body.items).toHaveLength(1)
    expect(body.nextCursor).toBeNull()
  })

  test('GET /:id/messages maps invalid cursor to 422 envelope', async () => {
    const app = buildApp({
      listMessages: async () => {
        throw new MessageServiceError(422, 'VALIDATION_FAILED', '游标不合法')
      },
    })
    const response = await app.request(conversationPath)
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      error: { code: 'VALIDATION_FAILED', message: '游标不合法' },
    })
  })

  test('POST /:id/messages returns 201 with the created message', async () => {
    const response = await buildApp().request(conversationPath, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '还在吗' }),
    })
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual(message)
  })

  test('POST /:id/messages rejects a whitespace-only body with 422', async () => {
    const response = await buildApp().request(conversationPath, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '   ' }),
    })
    expect(response.status).toBe(422)
  })

  test('GET /:id/messages rejects a malformed conversation id before the service', async () => {
    let called = false
    const app = buildApp({
      listMessages: async () => {
        called = true
        return { items: [], nextCursor: null }
      },
    })
    const response = await app.request('/conversations/not-a-uuid/messages')
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: { code: 'CONVERSATION_NOT_FOUND', message: '会话不存在' },
    })
    expect(called).toBe(false)
  })

  test('POST /:id/messages rejects a malformed conversation id before the service', async () => {
    let called = false
    const app = buildApp({
      sendTextMessage: async () => {
        called = true
        return message
      },
    })
    const response = await app.request('/conversations/not-a-uuid/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: { code: 'CONVERSATION_NOT_FOUND', message: '会话不存在' },
    })
    expect(called).toBe(false)
  })

  test('POST /:id/messages maps 404 CONVERSATION_NOT_FOUND from the service', async () => {
    const app = buildApp({
      sendTextMessage: async () => {
        throw new MessageServiceError(404, 'CONVERSATION_NOT_FOUND', '会话不存在')
      },
    })
    const response = await app.request(conversationPath, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    })
    expect(response.status).toBe(404)
  })

  test('POST /:id/messages forwards clientRequestId and maps 409', async () => {
    let seen: unknown
    const app = buildApp({
      sendTextMessage: async (_userId, _conversationId, input) => {
        seen = input
        throw new MessageServiceError(409, 'IDEMPOTENCY_KEY_REUSED', '重复的请求标识')
      },
    })
    const clientRequestId = '01990000-0000-7000-8000-0000000000f3'
    const response = await app.request(conversationPath, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hi', clientRequestId }),
    })
    expect(seen).toEqual({ content: 'hi', clientRequestId })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: { code: 'IDEMPOTENCY_KEY_REUSED', message: '重复的请求标识' },
    })
  })

  test('POST /:id/messages rejects a non-uuid clientRequestId with 422', async () => {
    let called = false
    const app = buildApp({
      sendTextMessage: async () => {
        called = true
        return message
      },
    })
    const response = await app.request(conversationPath, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hi', clientRequestId: 'not-a-uuid' }),
    })
    expect(response.status).toBe(422)
    expect(called).toBe(false)
  })

  /* #359：同一个端点按判别值分流到商品卡发送，TEXT 的两种旧形态都保持不变。 */
  test('POST /:id/messages 按 type=LISTING 分流到 sendListingMessage（201）', async () => {
    const listingCard: MessageDto = {
      ...message,
      type: 'LISTING',
      content: listingId,
      listing: {
        id: listingId,
        title: 'K380 键盘',
        priceCents: 16000,
        status: 'ACTIVE',
        coverUrl: null,
      },
    }
    let seen: unknown
    const app = buildApp({
      sendListingMessage: async (_userId, _conversationId, input) => {
        seen = input
        return listingCard
      },
    })
    const response = await app.request(conversationPath, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'LISTING',
        listingId,
        clientRequestId: '01990000-0000-7000-8000-0000000000f4',
      }),
    })
    expect(response.status).toBe(201)
    expect(seen).toEqual({
      type: 'LISTING',
      listingId,
      clientRequestId: '01990000-0000-7000-8000-0000000000f4',
    })
    expect(await response.json()).toEqual(listingCard)
  })

  test('POST /:id/messages 仍接受不带判别值的 TEXT 体（旧客户端零升级）', async () => {
    let seen: unknown
    const app = buildApp({
      sendTextMessage: async (_userId, _conversationId, input) => {
        seen = input
        return message
      },
    })
    const response = await app.request(conversationPath, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    })
    expect(response.status).toBe(201)
    expect(seen).toEqual({ content: 'hi' })
  })

  test('POST /:id/messages 接受显式 type=TEXT（与 LISTING 同风格的判别式调用方）', async () => {
    let seen: unknown
    const app = buildApp({
      sendTextMessage: async (_userId, _conversationId, input) => {
        seen = input
        return message
      },
    })
    const response = await app.request(conversationPath, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'TEXT', content: 'hi' }),
    })
    expect(response.status).toBe(201)
    expect(seen).toEqual({ type: 'TEXT', content: 'hi' })
  })

  test('POST /:id/messages rejects a LISTING body without listingId with 422', async () => {
    let called = false
    const app = buildApp({
      sendListingMessage: async () => {
        called = true
        return message
      },
    })
    const response = await app.request(conversationPath, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'LISTING' }),
    })
    expect(response.status).toBe(422)
    expect(called).toBe(false)
  })
})
