import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  createListing,
  fetchPolishCandidates,
  imagePreparationMessage,
  PublishTaskCancelledError,
  uploadListingImage,
  validateImageFile,
} from './api'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('publish API', () => {
  test('rejects a conflicting MIME type and an empty image locally', () => {
    expect(
      validateImageFile(new File(['not-an-image'], 'fake.jpg', { type: 'application/pdf' })),
    ).toBe('仅支持 JPG / PNG / WebP 图片')
    expect(validateImageFile(new File([], 'empty.jpg', { type: 'image/jpeg' }))).toBe(
      '图片文件为空或无法读取',
    )
    expect(
      imagePreparationMessage(new File(['pdf'], 'fake.jpg', { type: 'application/pdf' })),
    ).toBe('仅支持 JPG / PNG / WebP 图片')
    expect(imagePreparationMessage(new File(['heic'], 'photo.heic', { type: 'image/heic' }))).toBe(
      'HEIC 图片转换失败，请改用 JPG / PNG / WebP',
    )
  })

  test('引用 confirm 固化后的 final 键，而不是 presign 签发的 staging 键', async () => {
    // presign 只签 staging 前缀，可引用键必须来自 confirm（#286）。
    const STAGING_KEY = 'listing-media/u/staging.jpg'
    const FINAL_KEY = 'listings/u/image.jpg'
    const calls: Array<{ url: string; method: string; body: string | null }> = []
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
      if (url === '/api/uploads/confirm') {
        return Response.json({
          objectKey: FINAL_KEY,
          url: `https://cdn.test/${FINAL_KEY}`,
        })
      }
      return new Response(null, { status: 500 })
    }) as unknown as typeof fetch

    const file = new File(['image'], 'photo.jpg', { type: 'image/jpeg' })
    await expect(uploadListingImage(file, { isCurrent: () => true })).resolves.toBe(FINAL_KEY)
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

  test('stops before object upload and confirm after the session becomes stale', async () => {
    let stale = false
    const calls: string[] = []
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push(url)
      stale = true
      return Response.json({
        uploadUrl: 'https://object.test/put',
        objectKey: 'listing-media/u/staging.jpg',
        headers: {},
        expiresAt: '2026-09-26T00:00:00.000Z',
      })
    }) as unknown as typeof fetch

    const file = new File(['image'], 'photo.jpg', { type: 'image/jpeg' })
    await expect(uploadListingImage(file, { isCurrent: () => !stale })).rejects.toBeInstanceOf(
      PublishTaskCancelledError,
    )
    expect(calls).toEqual(['/api/uploads/presign'])
  })

  test('passes structured retry time through AI quota errors', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'AI_POLISH_QUOTA',
              message: '请求过于频繁',
              retryAfterSeconds: 42,
            },
          }),
          { status: 429, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof fetch

    await expect(
      fetchPolishCandidates({ title: '教材', description: '九成新', category: 'BOOKS' }),
    ).rejects.toMatchObject({ code: 'AI_POLISH_QUOTA', retryAfterSeconds: 42 })
  })

  test('rejects invalid create input before fetch', async () => {
    let called = false
    globalThis.fetch = mock(async () => {
      called = true
      return new Response(null, { status: 500 })
    }) as unknown as typeof fetch

    await expect(
      createListing({
        title: '教材',
        description: '九成新',
        priceCents: 100,
        category: 'BOOKS',
        condition: 'LIKE_NEW',
        urgent: false,
        negotiable: false,
        free: true,
        objectKeys: ['listings/u/a.jpg'],
      }),
    ).rejects.toBeDefined()
    expect(called).toBe(false)
  })

  test('creates a listing through POST /listings and parses the returned detail', async () => {
    const calls: Array<{ url: string; method: string }> = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({ url, method: init?.method ?? 'GET' })
      return Response.json(
        {
          id: 'lst_01jc000000e00800000000000t',
          title: '教材',
          priceCents: 100,
          category: 'BOOKS',
          condition: 'LIKE_NEW',
          status: 'OFFLINE',
          urgent: false,
          negotiable: false,
          free: false,
          coverUrl: null,
          // 想要数（已建会话的买家数）：卡片契约的必填字段，夹具给 0。
          wants: 0,
          createdAt: '2026-09-26T00:00:00.000Z',
          moderationStatus: 'REVIEW',
          description: '九成新',
          images: [],
          seller: {
            id: 'usr_01jc000000e00800000000000b',
            nickname: '卖家',
            avatarUrl: null,
            authStatus: 'UNVERIFIED',
          },
          isOwner: true,
          updatedAt: '2026-09-26T00:00:00.000Z',
        },
        { status: 201 },
      )
    }) as unknown as typeof fetch

    const detail = await createListing({
      title: '教材',
      description: '九成新',
      priceCents: 100,
      category: 'BOOKS',
      condition: 'LIKE_NEW',
      urgent: false,
      negotiable: false,
      free: false,
      objectKeys: ['listings/u/a.jpg'],
    })

    expect(detail.moderationStatus).toBe('REVIEW')
    expect(calls).toEqual([{ url: '/api/listings', method: 'POST' }])
  })
})
