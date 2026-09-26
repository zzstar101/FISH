import { describe, expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { createUploadService, UploadServiceError } from './service'
import type { MediaStorage } from './storage'

const USER_ID = '01930000-0000-7000-8000-00000000000a'
const OTHER_ID = '01930000-0000-7000-8000-00000000000b'
const PREFIX = `listings/${encodePublicId(PUBLIC_ID_PREFIX.user, USER_ID)}/`
const NEW_KEY = `${PREFIX}${encodePublicId(PUBLIC_ID_PREFIX.media, '01930000-0000-7000-8000-00000000000c')}.jpg`

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

    expect(jpeg.objectKey.startsWith(PREFIX)).toBe(true)
    expect(jpeg.objectKey).toMatch(/\/med_[a-z0-9]+\.jpg$/)
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
    const key = NEW_KEY

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
      service.confirm(USER_ID, {
        objectKey: `listings/${encodePublicId(PUBLIC_ID_PREFIX.user, OTHER_ID)}/a.jpg`,
      }),
    )
    expect(error.code).toBe('IMAGE_REFERENCE_INVALID')
    expect(statCalled).toBe(false)
  })

  test('rejects a `..` key that only looks like it belongs to the caller（路径穿越）', async () => {
    let statCalled = false
    const service = createUploadService({
      storage: fakeStorage({
        stat: async () => {
          statCalled = true
          return { size: 1, contentType: 'image/jpeg' }
        },
      }),
    })

    const key = `${PREFIX}../${OTHER_ID}/x.jpg`
    // 前缀校验单独拦不住：这个键确实以调用方前缀开头，但 Bun.S3Client 拼 URL 时
    // 会把 `..` 归一化掉，实际请求别人的对象（#86 B 线评审 P1）。
    expect(key.startsWith(PREFIX)).toBe(true)

    const error = await expectUploadError(() => service.confirm(USER_ID, { objectKey: key }))
    expect(error.code).toBe('IMAGE_REFERENCE_INVALID')
    expect(statCalled).toBe(false)
  })

  test('rejects object keys that carry path syntax（空段 / 反斜杠 / 百分号编码）', async () => {
    const service = createUploadService({ storage: fakeStorage({ stat: async () => null }) })
    const keys = [
      `${PREFIX}/x.jpg`,
      `${PREFIX}..\\${OTHER_ID}/x.jpg`,
      `${PREFIX}..%2f${OTHER_ID}/x.jpg`,
      `${PREFIX}./x.jpg`,
      `/${PREFIX}x.jpg`,
    ]

    for (const objectKey of keys) {
      const error = await expectUploadError(() => service.confirm(USER_ID, { objectKey }))
      expect(error.code).toBe('IMAGE_REFERENCE_INVALID')
    }
  })

  test('rejects a key that was never uploaded', async () => {
    const service = createUploadService({ storage: fakeStorage({ stat: async () => null }) })
    const error = await expectUploadError(() => service.confirm(USER_ID, { objectKey: NEW_KEY }))
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
      (await expectUploadError(() => oversize.confirm(USER_ID, { objectKey: NEW_KEY }))).code,
    ).toBe('IMAGE_REFERENCE_INVALID')

    const wrongMime = createUploadService({
      storage: fakeStorage({ stat: async () => ({ size: 10, contentType: 'image/heic' }) }),
    })
    expect(
      (await expectUploadError(() => wrongMime.confirm(USER_ID, { objectKey: NEW_KEY }))).code,
    ).toBe('IMAGE_REFERENCE_INVALID')
  })
})
