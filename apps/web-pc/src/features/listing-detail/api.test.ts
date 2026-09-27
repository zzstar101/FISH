import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fetchListingDetail } from './api'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const listingId = '01930000-0000-7000-8000-000000000013'
const detailFixture = {
  id: listingId,
  title: '高等数学上册',
  priceCents: 2000,
  category: 'BOOKS',
  condition: 'GOOD',
  status: 'ACTIVE',
  urgent: false,
  negotiable: false,
  free: false,
  coverUrl: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  moderationStatus: null,
  description: '无笔记，封面完整。',
  images: [],
  seller: {
    id: '01930000-0000-7000-8000-00000000000a',
    nickname: '阿岚',
    avatarUrl: null,
    authStatus: 'VERIFIED',
  },
  isOwner: false,
  updatedAt: '2026-01-01T00:00:00.000Z',
}

describe('fetchListingDetail', () => {
  test('requests the detail endpoint and parses a valid response', async () => {
    let requestedUrl = ''
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      requestedUrl = String(input)
      return new Response(JSON.stringify(detailFixture), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const result = await fetchListingDetail(listingId)

    expect(requestedUrl).toBe(`/api/listings/${listingId}`)
    expect(result).toMatchObject({ id: listingId, title: detailFixture.title, images: [] })
  })

  test('does not hide a malformed 404 as a missing listing', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response('<html>not found</html>', {
          status: 404,
          headers: { 'content-type': 'text/html' },
        }),
    ) as unknown as typeof fetch

    await expect(fetchListingDetail(listingId)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      status: 404,
    })
  })

  test('maps a missing or invisible listing to null', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: 'LISTING_NOT_FOUND', message: '商品不存在或不可见' },
          }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof fetch

    await expect(fetchListingDetail('00000000-0000-4000-8000-000000000000')).resolves.toBeNull()
  })
})
