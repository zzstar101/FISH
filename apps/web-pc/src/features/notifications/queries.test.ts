import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { ListingDetail } from '@fish/contracts/listings/schema'
import { QueryClient } from '@tanstack/react-query'
import { listingDetailQueryKey } from '../listing-detail/queries'
import {
  fetchCurrentListingTarget,
  NOTIFICATION_POLL_INTERVAL_MS,
  notificationListQueryOptions,
  notificationUnreadQueryOptions,
} from './queries'

const originalFetch = globalThis.fetch

const listingId = 'lst_01jc000000e00800000000000t'
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
  wants: 0,
  description: '测试描述',
  images: [],
  seller: {
    id: 'usr_01jc000000e00800000000000b',
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

  test('通知 query 配置有限轮询与回到窗口刷新', () => {
    const list = notificationListQueryOptions(50)
    expect(list.refetchInterval).toBe(NOTIFICATION_POLL_INTERVAL_MS)
    expect(list.refetchOnMount).toBe('always')
    expect(list.refetchOnWindowFocus).toBe('always')

    const unread = notificationUnreadQueryOptions(true)
    expect(unread.refetchInterval).toBe(NOTIFICATION_POLL_INTERVAL_MS)
    expect(unread.refetchOnWindowFocus).toBe('always')
    // 未登录（enabled=false）时不轮询，避免匿名公开页被 401 挤出。
    expect(notificationUnreadQueryOptions(false).refetchInterval).toBe(false)
  })
})
