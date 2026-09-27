import { describe, expect, test } from 'bun:test'
import { errorBody } from '@fish/contracts/system/error'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import { allowRestrictionGuard } from '../governance/testing'
import { legacyMediaToken } from './legacy-url'
import { createUploadsRouter } from './router'
import type { MediaStorage } from './storage'

const USER_ID = '01930000-0000-7000-8000-00000000000a'
const NEW_KEY = `listings/${encodePublicId(PUBLIC_ID_PREFIX.user, USER_ID)}/${encodePublicId(PUBLIC_ID_PREFIX.media, '01930000-0000-7000-8000-00000000000b')}.jpg`
const LEGACY_SECRET = 'test-secret-for-legacy-media-longer-than-32-characters'

function fakeStorage(overrides: Partial<MediaStorage> = {}): MediaStorage {
  return {
    presignPut: () => ({
      url: 'https://s3.test/put?sig=x',
      headers: {},
      expiresAt: '2026-09-12T03:50:10.000Z',
    }),
    stat: async () => ({ size: 1024, contentType: 'image/jpeg' }),
    publicUrl: (key) => `https://cdn.test/${key}`,
    ...overrides,
  }
}

function buildApp(options: { storage: MediaStorage; authed?: boolean }) {
  const authed = options.authed ?? true
  const requireAuth: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
    if (!authed) return c.json(errorBody('UNAUTHENTICATED', '请先登录'), 401)
    c.set('userId', USER_ID)
    await next()
  }

  const root = new Hono()
  root.route(
    '/uploads',
    createUploadsRouter({
      storage: options.storage,
      legacyUrlSecret: LEGACY_SECRET,
      requireAuth,
      guard: allowRestrictionGuard,
    }),
  )
  return root
}

function post(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

describe('uploads router', () => {
  // 契约 §0.2：两个上传端点都在写接口表里，匿名必须 401（前端据此跳登录）。
  test('requires a session for both endpoints', async () => {
    const app = buildApp({ storage: fakeStorage(), authed: false })

    for (const path of ['/uploads/presign', '/uploads/confirm']) {
      const res = await app.request(path, post({}))
      expect(res.status).toBe(401)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED')
    }
  })

  test('returns a presigned upload for an allowed mime type', async () => {
    const app = buildApp({ storage: fakeStorage() })
    const res = await app.request(
      '/uploads/presign',
      post({ contentType: 'image/jpeg', sizeBytes: 1024 }),
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ uploadUrl: 'https://s3.test/put?sig=x', headers: {} })
  })

  // iOS 相册的 HEIC 不在允许列表里：契约 §1 的前端约束要求先转码，服务端必须明确拒绝。
  test('rejects a disallowed mime type and an oversize payload with field-level details', async () => {
    const app = buildApp({ storage: fakeStorage() })

    const heic = await app.request(
      '/uploads/presign',
      post({ contentType: 'image/heic', sizeBytes: 1024 }),
    )
    expect(heic.status).toBe(422)
    const heicBody = (await heic.json()) as {
      error: { code: string; details?: { field: string }[] }
    }
    expect(heicBody.error.code).toBe('VALIDATION_FAILED')
    expect(heicBody.error.details?.[0]?.field).toBe('contentType')

    const oversize = await app.request(
      '/uploads/presign',
      post({ contentType: 'image/jpeg', sizeBytes: 5 * 1024 * 1024 + 1 }),
    )
    expect(oversize.status).toBe(422)
    const oversizeBody = (await oversize.json()) as { error: { details?: { field: string }[] } }
    expect(oversizeBody.error.details?.[0]?.field).toBe('sizeBytes')
  })

  test('maps confirm failures onto the frozen error codes', async () => {
    const app = buildApp({ storage: fakeStorage({ stat: async () => null }) })
    const res = await app.request('/uploads/confirm', post({ objectKey: NEW_KEY }))

    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: { code: string; details?: { field: string }[] } }
    expect(body.error.code).toBe('UPLOAD_OBJECT_MISSING')
    // 契约 §3 的 422 校验类失败都带字段信息（口径见契约评论 §7.9）
    expect(body.error.details?.[0]?.field).toBe('objectKey')
  })

  test('历史图片以加密 token 匿名读取，非法 token 不访问存储', async () => {
    const oldKey = `listings/${USER_ID}/01930000-0000-4000-8000-00000000000c.jpg`
    const seen: string[] = []
    const app = buildApp({
      storage: fakeStorage({
        stat: async (key) => {
          seen.push(key)
          return { size: 3, contentType: 'image/jpeg' }
        },
        getObject: (key) => {
          seen.push(key)
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3]))
                controller.close()
              },
            }),
            contentType: 'image/jpeg',
          }
        },
      }),
      authed: false,
    })
    const token = legacyMediaToken(oldKey, LEGACY_SECRET)
    const response = await app.request(`/uploads/legacy/${token}`)
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(seen).toEqual([oldKey, oldKey])
    expect((await app.request('/uploads/legacy/invalid-token')).status).toBe(404)
    expect(seen).toHaveLength(2)
  })

  test('returns the public url on a successful confirm', async () => {
    const app = buildApp({ storage: fakeStorage() })
    const key = NEW_KEY
    const res = await app.request('/uploads/confirm', post({ objectKey: key }))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ objectKey: key, url: `https://cdn.test/${key}` })
  })
})
