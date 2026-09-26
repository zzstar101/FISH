import { describe, expect, test } from 'bun:test'
import type { MessageDto } from '@fish/contracts/chat/schema'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'

const CONVERSATION = '01930000-0000-7000-8000-0000000000c1'
const conversationPath = `/conversations/${encodePublicId(PUBLIC_ID_PREFIX.conversation, CONVERSATION)}/messages`
const sender = encodePublicId(PUBLIC_ID_PREFIX.user, '01930000-0000-7000-8000-0000000000a1')

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
  createdAt: '2026-09-12T10:00:00.000Z',
}

const service: MessageService = {
  listMessages: async () => ({ items: [message], nextCursor: null }),
  sendTextMessage: async () => message,
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
})
