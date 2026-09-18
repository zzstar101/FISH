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
    list: async () => ({ items: [], nextCursor: null }),
    getObject: async () => ({ key: 'chat-media/key.webp', contentType: 'image/webp', size: 10 }),
    ...overrides,
  }
  const storage: MediaStorage = {
    presignPut: () => ({ url: '', headers: {}, expiresAt: '' }),
    stat: async () => null,
    publicUrl: (key) => key,
    getObject: (_key, range) => ({
      stream: new Blob([
        new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]).slice(
          range?.start ?? 0,
          range ? range.end + 1 : undefined,
        ),
      ]).stream(),
      contentType: 'image/webp',
    }),
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

  test('serves bounded, open-ended and suffix byte ranges', async () => {
    for (const [range, expected, contentRange] of [
      ['bytes=2-4', [2, 3, 4], 'bytes 2-4/10'],
      ['bytes=8-', [8, 9], 'bytes 8-9/10'],
      ['bytes=-3', [7, 8, 9], 'bytes 7-9/10'],
      ['bytes=8-99', [8, 9], 'bytes 8-9/10'],
    ] as const) {
      const response = await buildApp().request(
        `/conversations/${conversationId}/media/${mediaId}`,
        {
          headers: { Range: range },
        },
      )
      expect(response.status).toBe(206)
      expect(response.headers.get('content-range')).toBe(contentRange)
      expect(response.headers.get('content-length')).toBe(String(expected.length))
      expect(response.headers.get('accept-ranges')).toBe('bytes')
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...expected])
    }
  })

  test('rejects unsatisfiable ranges and ignores unsupported range syntax', async () => {
    for (const range of ['bytes=10-', 'bytes=-0']) {
      const response = await buildApp().request(
        `/conversations/${conversationId}/media/${mediaId}`,
        {
          headers: { Range: range },
        },
      )
      expect(response.status).toBe(416)
      expect(response.headers.get('content-range')).toBe('bytes */10')
    }
    const response = await buildApp().request(`/conversations/${conversationId}/media/${mediaId}`, {
      headers: { Range: 'bytes=0-1,4-5' },
    })
    expect(response.status).toBe(200)
    expect((await response.arrayBuffer()).byteLength).toBe(10)
  })

  test('passes the pagination query through and returns the cursor envelope', async () => {
    const calls: { cursor?: string; limit: number }[] = []
    const app = buildApp({
      list: async (_userId, _conversationId, query) => {
        calls.push(query)
        return { items: [], nextCursor: 'next-page-cursor' }
      },
    })

    const response = await app.request(`/conversations/${conversationId}/media?limit=7&cursor=abc`)
    expect(response.status).toBe(200)
    expect(calls).toEqual([{ limit: 7, cursor: 'abc' }])
    expect(await response.json()).toEqual({ items: [], nextCursor: 'next-page-cursor' })
  })

  // 回归（评审 F-3）：非 UUID 的路径参数必须按"不存在"处理，不能让它走到 SQL 的 ::uuid
  // 转换而变成 500（PostgresError 22P02）。
  test('returns 404 for a non-UUID conversation id instead of a 500', async () => {
    const app = buildApp()
    for (const path of [
      '/conversations/not-a-uuid/media',
      '/conversations/not-a-uuid/media/presign',
    ]) {
      const response = await app.request(path, {
        method: path.endsWith('presign') ? 'POST' : 'GET',
        ...(path.endsWith('presign')
          ? {
              body: JSON.stringify({ kind: 'IMAGE', contentType: 'image/webp', sizeBytes: 1 }),
              headers: { 'content-type': 'application/json' },
            }
          : {}),
      })
      expect(response.status).toBe(404)
    }

    const objectResponse = await app.request(`/conversations/${conversationId}/media/not-a-uuid`)
    expect(objectResponse.status).toBe(404)
  })

  test('rejects an out-of-range limit with 422', async () => {
    const response = await buildApp().request(`/conversations/${conversationId}/media?limit=0`)
    expect(response.status).toBe(422)
  })
})
