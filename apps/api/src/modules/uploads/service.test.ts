import { describe, expect, test } from 'bun:test'
import { createUploadService, UploadServiceError } from './service'
import type { MediaStorage } from './storage'

const USER_ID = '01930000-0000-7000-8000-00000000000a'
const OTHER_ID = '01930000-0000-7000-8000-00000000000b'

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

async function expectUploadError(run: () => Promise<unknown>): Promise<UploadServiceError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof UploadServiceError) return error
    throw error
  }
  throw new Error('期望抛出 UploadServiceError，但没有')
}

describe('presign', () => {
  test('generates a server-side key under the caller prefix with a mime-derived extension', async () => {
    const service = createUploadService({ storage: fakeStorage() })

    const jpeg = await service.presign(USER_ID, { contentType: 'image/jpeg', sizeBytes: 1024 })
    const webp = await service.presign(USER_ID, { contentType: 'image/webp', sizeBytes: 1024 })

    expect(jpeg.objectKey.startsWith(`listings/${USER_ID}/`)).toBe(true)
    expect(jpeg.objectKey.endsWith('.jpg')).toBe(true)
    expect(webp.objectKey.endsWith('.webp')).toBe(true)
    // 每次 presign 都是新对象：重试时前端替换槽位，旧键成为孤儿（契约 §4 取舍 1）
    expect(jpeg.objectKey).not.toBe(webp.objectKey)
    expect(jpeg.uploadUrl).toBe('https://s3.test/put?sig=x')
    expect(jpeg.expiresAt).toBe('2026-09-12T03:50:10.000Z')
  })

  test('passes the requested content type to the storage layer', async () => {
    const asked: string[] = []
    const service = createUploadService({
      storage: fakeStorage({
        presignPut: (input) => {
          asked.push(input.contentType)
          return { url: 'https://s3.test/put', headers: {}, expiresAt: '2026-09-12T03:50:10.000Z' }
        },
      }),
    })

    await service.presign(USER_ID, { contentType: 'image/png', sizeBytes: 1024 })
    expect(asked).toEqual(['image/png'])
  })
})

describe('confirm', () => {
  test('returns the public url for an object the caller owns', async () => {
    const service = createUploadService({ storage: fakeStorage() })
    const key = `listings/${USER_ID}/a.jpg`

    expect(await service.confirm(USER_ID, { objectKey: key })).toEqual({
      objectKey: key,
      url: `https://cdn.test/${key}`,
    })
  })

  test('rejects an object key belonging to another user before touching storage', async () => {
    let statCalled = false
    const service = createUploadService({
      storage: fakeStorage({
        stat: async () => {
          statCalled = true
          return { size: 1, contentType: 'image/jpeg' }
        },
      }),
    })

    const error = await expectUploadError(() =>
      service.confirm(USER_ID, { objectKey: `listings/${OTHER_ID}/a.jpg` }),
    )
    expect(error.code).toBe('IMAGE_REFERENCE_INVALID')
    expect(statCalled).toBe(false)
  })

  test('rejects a key that was never uploaded', async () => {
    const service = createUploadService({ storage: fakeStorage({ stat: async () => null }) })
    const error = await expectUploadError(() =>
      service.confirm(USER_ID, { objectKey: `listings/${USER_ID}/a.jpg` }),
    )
    expect(error.code).toBe('UPLOAD_OBJECT_MISSING')
  })

  // presign 的签名只覆盖 host，mime 与大小只能查真实对象（契约 §7.7）。
  test('rejects objects whose real size or mime type is not allowed', async () => {
    const oversize = createUploadService({
      storage: fakeStorage({
        stat: async () => ({ size: 5 * 1024 * 1024 + 1, contentType: 'image/jpeg' }),
      }),
    })
    expect(
      (
        await expectUploadError(() =>
          oversize.confirm(USER_ID, { objectKey: `listings/${USER_ID}/a.jpg` }),
        )
      ).code,
    ).toBe('IMAGE_REFERENCE_INVALID')

    const wrongMime = createUploadService({
      storage: fakeStorage({ stat: async () => ({ size: 10, contentType: 'image/heic' }) }),
    })
    expect(
      (
        await expectUploadError(() =>
          wrongMime.confirm(USER_ID, { objectKey: `listings/${USER_ID}/a.jpg` }),
        )
      ).code,
    ).toBe('IMAGE_REFERENCE_INVALID')
  })
})
