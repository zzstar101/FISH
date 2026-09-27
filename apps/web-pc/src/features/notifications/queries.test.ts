import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { ListingDetail } from '@fish/contracts/listings/schema'
import { QueryClient } from '@tanstack/react-query'
import { listingDetailQueryKey } from '../listing-detail/queries'
import { fetchCurrentListingTarget } from './queries'

const originalFetch = globalThis.fetch

const listingId = '01930000-0000-7000-8000-000000000001'
const listing: ListingDetail = {
  id: listingId,
  title: '测试商品',
  priceCents: 100,
  category: 'OTHER',
  condition: 'GOOD',
  status: 'ACTIVE',
  urgent: false,
  negotiable: false,
  free: false,
  coverUrl: null,
  createdAt: '2026-09-26T00:00:00.000Z',
  moderationStatus: null,
  description: '测试描述',
  images: [],
  seller: {
    id: '01930000-0000-7000-8000-000000000002',
    nickname: '卖家',
    avatarUrl: null,
    authStatus: 'UNVERIFIED',
  },
  isOwner: false,
  updatedAt: '2026-09-26T00:00:00.000Z',
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('notification queries', () => {
  test('rechecks the listing before a notification target is opened', async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(listingDetailQueryKey(listingId), listing)
    const calls: string[] = []
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push(url)
      return Response.json(
        { error: { code: 'LISTING_NOT_FOUND', message: '商品不存在' } },
        { status: 404 },
      )
    }) as unknown as typeof fetch

    await expect(fetchCurrentListingTarget(queryClient, listingId)).resolves.toBeNull()
    expect(calls).toEqual([`/api/listings/${listingId}`])
  })
})
