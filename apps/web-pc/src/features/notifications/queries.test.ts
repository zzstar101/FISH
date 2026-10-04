import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { ListingDetail } from '@fish/contracts/listings/schema'
import type { WishDto } from '@fish/contracts/wishes/schema'
import { QueryClient } from '@tanstack/react-query'
import { listingDetailQueryKey } from '../listing-detail/queries'
import { wishKeys } from '../wish/queries'
import {
  fetchCurrentListingTarget,
  fetchCurrentWishTarget,
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

describe('fetchCurrentWishTarget（#446 wishId 通知预检）', () => {
  const ownerId = 'usr_01jc000000e00800000000000a'
  const wishId = 'wsh_01jc000000e00800000000003t'
  const wish: WishDto = {
    id: wishId,
    userId: ownerId,
    keyword: '考研数学书',
    category: 'BOOKS',
    budgetMinCents: 0,
    budgetMaxCents: 5000,
    description: null,
    acceptSimilar: true,
    status: 'ACTIVE',
    matchCount: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }

  function stubFetch(status: number, body: unknown): { calls: string[] } {
    const calls: string[] = []
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push(url)
      return Response.json(body, { status })
    }) as unknown as typeof fetch
    return { calls }
  }

  test('404（不存在或不是本人的）→ null，回落通知列表', async () => {
    const queryClient = new QueryClient()
    const { calls } = stubFetch(404, { error: { code: 'WISH_NOT_FOUND', message: '愿望不存在' } })

    await expect(fetchCurrentWishTarget(queryClient, ownerId, wishId)).resolves.toBeNull()
    expect(calls).toEqual([`/api/wishes/${wishId}`])
  })

  test('403 同样视为不可见（与预检「回落」口径一致）', async () => {
    const queryClient = new QueryClient()
    stubFetch(403, { error: { code: 'FORBIDDEN', message: '无权访问' } })

    await expect(fetchCurrentWishTarget(queryClient, ownerId, wishId)).resolves.toBeNull()
  })

  test('其他错误（如 500）原样抛出，页面给「暂时无法确认」而不是回落', async () => {
    const queryClient = new QueryClient()
    stubFetch(500, { error: { code: 'INTERNAL', message: 'boom' } })

    await expect(fetchCurrentWishTarget(queryClient, ownerId, wishId)).rejects.toThrow()
  })

  test('成功结果写入 wishKeys.detail 缓存，与详情页同键（跳转后不重复请求）', async () => {
    const queryClient = new QueryClient()
    stubFetch(200, wish)

    const result = await fetchCurrentWishTarget(queryClient, ownerId, wishId)
    expect(result).toEqual(wish)
    // getQueryData 未注册类型时 bun-types 的 expect 泛型会推断成 undefined，显式钉住
    const cached = queryClient.getQueryData<WishDto>(wishKeys.detail(ownerId, wishId))
    expect(cached).toEqual(wish)
  })
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
