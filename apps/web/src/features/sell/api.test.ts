import { afterEach, describe, expect, mock, test } from 'bun:test'
import { ApiError } from '../../lib/api-client'
import { uploadImage } from './api'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

/** presign 只签 staging 前缀；可引用键由 confirm 在审核固化后另行生成（#286）。 */
const STAGING_KEY =
  'listing-media/usr_01jc000000e00800000000000b/med_01jc000000e00800000000000c.jpg'
const FINAL_KEY = 'listings/usr_01jc000000e00800000000000b/med_01jc000000e00800000000000d.jpg'

type Call = { url: string; method: string; body: string | null }

function stubUpload(confirm: () => Response): Call[] {
  const calls: Call[] = []
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : null,
    })

    if (url === '/api/uploads/presign') {
      return Response.json({
        uploadUrl: 'https://object.test/put',
        objectKey: STAGING_KEY,
        headers: {},
        expiresAt: '2026-09-26T00:00:00.000Z',
      })
    }
    if (url === 'https://object.test/put') return new Response(null, { status: 200 })
    if (url === '/api/uploads/confirm') return confirm()
    return new Response(null, { status: 500 })
  }) as unknown as typeof fetch
  return calls
}

describe('Web listing image upload', () => {
  test('引用 confirm 固化后的 final 键，而不是 presign 签发的 staging 键', async () => {
    const calls = stubUpload(() =>
      Response.json({ objectKey: FINAL_KEY, url: `https://cdn.test/${FINAL_KEY}` }),
    )

    const key = await uploadImage(new File(['image'], 'photo.jpg', { type: 'image/jpeg' }))

    expect(key).toBe(FINAL_KEY)
    expect(key).not.toBe(STAGING_KEY)
    expect(calls).toEqual([
      {
        url: '/api/uploads/presign',
        method: 'POST',
        body: JSON.stringify({ contentType: 'image/jpeg', sizeBytes: 5 }),
      },
      { url: 'https://object.test/put', method: 'PUT', body: null },
      {
        url: '/api/uploads/confirm',
        method: 'POST',
        body: JSON.stringify({ objectKey: STAGING_KEY }),
      },
    ])
  })

  test('confirm 被拒时不把 staging 键当可用引用键返回', async () => {
    stubUpload(() =>
      Response.json(
        { error: { code: 'IMAGE_CONTENT_BLOCKED', message: '图片内容未通过审核' } },
        { status: 422 },
      ),
    )

    const rejected = uploadImage(new File(['image'], 'photo.jpg', { type: 'image/jpeg' }))
    await expect(rejected).rejects.toBeInstanceOf(ApiError)
    await expect(rejected).rejects.toMatchObject({
      code: 'IMAGE_CONTENT_BLOCKED',
      status: 422,
    })
  })
})
