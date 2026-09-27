import { describe, expect, test } from 'bun:test'
import { errorBody } from '@fish/contracts/system/error'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import type { AuthVariables } from '../auth/middleware'
import { allowRestrictionGuard } from '../governance/testing'
import { legacyMediaToken } from './legacy-url'
import { createUploadsRouter } from './router'
import { type UploadService, UploadServiceError } from './service'
import { isListingMediaStagingKey, type MediaStorage } from './storage'

const USER_ID = '01930000-0000-7000-8000-00000000000a'
const STAGING_KEY = `listing-media/${encodePublicId(PUBLIC_ID_PREFIX.user, USER_ID)}/${encodePublicId(PUBLIC_ID_PREFIX.media, '01930000-0000-7000-8000-00000000000d')}.jpg`
const FINAL_KEY = `listings/${encodePublicId(PUBLIC_ID_PREFIX.user, USER_ID)}/${encodePublicId(PUBLIC_ID_PREFIX.media, '01930000-0000-7000-8000-00000000000e')}.jpg`
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

type FakeService = UploadService & { calls: { userId: string; objectKey: string }[] }

function fakeService(overrides: Partial<UploadService> = {}): FakeService {
  const calls: { userId: string; objectKey: string }[] = []
  return {
    calls,
    presign: async () => ({
      uploadUrl: 'https://s3.test/put?sig=x',
      objectKey: STAGING_KEY,
      headers: {},
      expiresAt: '2026-09-12T03:50:10.000Z',
    }),
    confirm: async (userId, input) => {
      calls.push({ userId, objectKey: input.objectKey })
      return { objectKey: FINAL_KEY, url: `https://cdn.test/${FINAL_KEY}` }
    },
    ...overrides,
  }
}

function buildApp(options: { storage: MediaStorage; authed?: boolean; service?: UploadService }) {
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
      service: options.service ?? fakeService(),
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

  test('presigns a staging key and confirm answers with the fixated final key', async () => {
    const service = fakeService()
    const app = buildApp({ storage: fakeStorage(), service })

    const presigned = (await (
      await app.request('/uploads/presign', post({ contentType: 'image/jpeg', sizeBytes: 1024 }))
    ).json()) as { objectKey: string; uploadUrl: string; headers: Record<string, string> }

    expect(presigned.uploadUrl).toBe('https://s3.test/put?sig=x')
    expect(presigned.headers).toEqual({})
    // #286：presign 只签 staging 前缀，客户端结构上拿不到 final 前缀的写权限。
    expect(isListingMediaStagingKey(presigned.objectKey)).toBe(true)
    expect(presigned.objectKey.startsWith('listings/')).toBe(false)

    const confirmed = await app.request(
      '/uploads/confirm',
      post({ objectKey: presigned.objectKey }),
    )
    const body = (await confirmed.json()) as { objectKey: string; url: string }

    // 可引用的键来自 confirm 响应，而不是客户端 PUT 的那个 staging 键。
    expect(body.objectKey).toBe(FINAL_KEY)
    expect(body.objectKey).not.toBe(presigned.objectKey)
    expect(body.url).toBe(`https://cdn.test/${FINAL_KEY}`)
    expect(service.calls).toEqual([{ userId: USER_ID, objectKey: presigned.objectKey }])
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
    const cases = [
      new UploadServiceError(422, 'UPLOAD_OBJECT_MISSING', '图片尚未上传完成', [
        { field: 'objectKey', message: '图片尚未上传完成' },
      ]),
      new UploadServiceError(422, 'IMAGE_CONTENT_BLOCKED', '图片内容未通过审核', [
        { field: 'objectKey', message: '图片内容未通过审核' },
      ]),
      new UploadServiceError(
        400,
        'CONTENT_MODERATION_INVALID_INPUT',
        '图片审核暂时不可用，请稍后重试',
        [{ field: 'objectKey', message: '图片审核暂时不可用，请稍后重试' }],
      ),
      new UploadServiceError(
        503,
        'CONTENT_MODERATION_UNAVAILABLE',
        '图片审核暂时不可用，请稍后重试',
        [{ field: 'objectKey', message: '图片审核暂时不可用，请稍后重试' }],
      ),
    ]

    for (const error of cases) {
      const app = buildApp({
        storage: fakeStorage({ stat: async () => null }),
        service: fakeService({
          confirm: async () => {
            throw error
          },
        }),
      })
      const res = await app.request('/uploads/confirm', post({ objectKey: STAGING_KEY }))

      expect(res.status).toBe(error.status)
      const body = (await res.json()) as {
        error: { code: string; message: string; details?: { field: string }[] }
      }
      expect(body.error.code).toBe(error.code)
      expect(body.error.message).toBe(error.message)
      // 契约 §3 的 422/503 校验类失败都带字段信息（口径见契约评论 §7.9）
      expect(body.error.details?.[0]?.field).toBe('objectKey')
    }
  })

  test('rejects a malformed confirm body before the service runs', async () => {
    let called = false
    const app = buildApp({
      storage: fakeStorage(),
      service: fakeService({
        confirm: async () => {
          called = true
          return { objectKey: FINAL_KEY, url: `https://cdn.test/${FINAL_KEY}` }
        },
      }),
    })

    const res = await app.request('/uploads/confirm', post({ objectKey: '' }))

    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED')
    expect(called).toBe(false)
  })

  test('does not pretend an unexpected failure is an upload error', async () => {
    const app = buildApp({
      storage: fakeStorage(),
      service: fakeService({
        confirm: async () => {
          throw new Error('boom')
        },
      }),
    })

    const res = await app.request('/uploads/confirm', post({ objectKey: STAGING_KEY }))
    expect(res.status).toBe(500)
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
})
