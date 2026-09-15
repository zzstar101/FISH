import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { MediaStorage } from '../uploads/storage'
import { createMediaRouter } from './media-router'
import type { MediaMessageService } from './media-service'

const conversationId = '11111111-1111-4111-8111-111111111111'
const mediaId = '22222222-2222-4222-8222-222222222222'

const requireAuth = async (
  c: Parameters<NonNullable<Parameters<typeof createMediaRouter>[0]['requireAuth']>>[0],
  next: () => Promise<void>,
) => {
  c.set('userId', '33333333-3333-4333-8333-333333333333')
  await next()
}

function buildApp(overrides: Partial<MediaMessageService> = {}) {
  const service: MediaMessageService = {
    presign: async () => ({
      uploadUrl: 'https://upload.test/file',
      objectKey: 'chat-media/key.webp',
      headers: {},
      expiresAt: '2026-09-14T12:10:00.000Z',
    }),
    create: async () => ({
      id: '44444444-4444-4444-8444-444444444444',
      conversationId,
      senderId: '33333333-3333-4333-8333-333333333333',
      kind: 'IMAGE',
      mediaId,
      url: `/conversations/${conversationId}/media/${mediaId}`,
      mimeType: 'image/webp',
      sizeBytes: 100,
      width: 100,
      height: 80,
      durationMs: null,
      createdAt: '2026-09-14T12:00:00.000Z',
    }),
    list: async () => [],
    getObject: async () => ({ key: 'chat-media/key.webp', contentType: 'image/webp' }),
    ...overrides,
  }
  const storage: MediaStorage = {
    presignPut: () => ({ url: '', headers: {}, expiresAt: '' }),
    stat: async () => null,
    publicUrl: (key) => key,
    getObject: () => ({ stream: new ReadableStream(), contentType: 'image/webp' }),
  }
  const app = new Hono()
  app.route('/conversations', createMediaRouter({ service, storage, requireAuth }))
  return app
}

describe('media router', () => {
  test('requires the media payload and returns a presign response', async () => {
    const app = buildApp()
    const invalid = await app.request(`/conversations/${conversationId}/media/presign`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'IMAGE', contentType: 'image/webp' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(invalid.status).toBe(422)

    const response = await app.request(`/conversations/${conversationId}/media/presign`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'IMAGE', contentType: 'image/webp', sizeBytes: 100 }),
      headers: { 'content-type': 'application/json' },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { objectKey: string }
    expect(body.objectKey).toBe('chat-media/key.webp')
  })

  test('serves authorized media bytes with private response headers', async () => {
    const response = await buildApp().request(`/conversations/${conversationId}/media/${mediaId}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/webp')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })
})
