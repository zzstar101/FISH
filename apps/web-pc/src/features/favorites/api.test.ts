import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  favoriteRelationPath,
  fetchFavoriteState,
  fetchMyFavorites,
  myFavoritesPath,
  requestFavorite,
  requestUnfavorite,
} from './api'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const listingId = 'lst_01jc000000e00800000000000k'

describe('myFavoritesPath', () => {
  test('恒带 limit，cursor 缺省不带', () => {
    expect(myFavoritesPath({ limit: 20 })).toBe('/me/favorites?limit=20')
  })

  test('翻页时把上一页的 nextCursor 原样带上', () => {
    expect(myFavoritesPath({ limit: 20, cursor: 'abc+/=' })).toBe(
      '/me/favorites?limit=20&cursor=abc%2B%2F%3D',
    )
  })
})

describe('favoriteRelationPath', () => {
  test('规范商品 ID 原样进路径', () => {
    expect(favoriteRelationPath(listingId)).toBe(`/listings/${listingId}/favorite`)
  })

  test('非规范 ID（uuid / 裸数字）不拼 URL，直接判不可用', () => {
    expect(favoriteRelationPath('3f9d1c2e-0000-4000-8000-000000000000')).toBeNull()
    expect(favoriteRelationPath('1234567890')).toBeNull()
  })
})

describe('fetchMyFavorites', () => {
  test('GET /me/favorites 并用契约收口响应', async () => {
    const calls: Array<{ url: string; method: string }> = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({ url, method: init?.method ?? 'GET' })
      return Response.json({
        items: [
          {
            listing: {
              id: listingId,
              title: '高等数学上册',
              priceCents: 2000,
              category: 'BOOKS',
              condition: 'GOOD',
              status: 'SOLD',
              urgent: false,
              negotiable: false,
              free: false,
              coverUrl: null,
              // 想要数（已建会话的买家数）：卡片契约的必填字段，夹具给 0。
              wants: 0,
              views: 0,
              createdAt: '2026-01-01T00:00:00.000Z',
              moderationStatus: null,
            },
            favoritedAt: '2026-01-02T00:00:00.000Z',
          },
        ],
        nextCursor: null,
        total: 1,
      })
    }) as unknown as typeof fetch

    const result = await fetchMyFavorites({ limit: 20 })

    expect(calls).toEqual([{ url: '/api/me/favorites?limit=20', method: 'GET' }])
    expect(result.total).toBe(1)
    expect(result.nextCursor).toBeNull()
    expect(result.items[0]?.listing.status).toBe('SOLD')
  })

  test('响应形状漂移在进 UI 前暴露', async () => {
    globalThis.fetch = mock(async () => Response.json({ items: 'oops' })) as unknown as typeof fetch
    await expect(fetchMyFavorites({ limit: 20 })).rejects.toThrow()
  })
})

describe('favoriteRelationPath 三方法', () => {
  function mockState(favorited: boolean) {
    globalThis.fetch = mock(async () => Response.json({ favorited })) as unknown as typeof fetch
  }

  test('GET 读状态：200 回 loaded', async () => {
    mockState(true)
    const outcome = await fetchFavoriteState(listingId)
    expect(outcome).toEqual({ kind: 'loaded', favorited: true })
  })

  test('GET 读状态：404（不存在/不可见/不在售）降级 notFound 而不是失败', async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ code: 'LISTING_NOT_FOUND', message: '商品不存在或不可见' }, { status: 404 }),
    ) as unknown as typeof fetch
    const outcome = await fetchFavoriteState(listingId)
    expect(outcome).toEqual({ kind: 'notFound' })
  })

  test('POST / DELETE 都打同一路径，且以服务端返回的 favorited 为准', async () => {
    const calls: Array<{ url: string; method: string }> = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({ url, method: init?.method ?? 'GET' })
      return Response.json({ favorited: init?.method === 'POST' })
    }) as unknown as typeof fetch

    const favorited = await requestFavorite(listingId)
    const unfavorited = await requestUnfavorite(listingId)

    expect(calls).toEqual([
      { url: `/api/listings/${listingId}/favorite`, method: 'POST' },
      { url: `/api/listings/${listingId}/favorite`, method: 'DELETE' },
    ])
    expect(favorited).toEqual({ kind: 'written', favorited: true })
    expect(unfavorited).toEqual({ kind: 'written', favorited: false })
  })

  test('写失败（商品刚失效 404）收口成 failed，不抛错也不给假成功', async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ code: 'LISTING_NOT_FOUND', message: '商品不存在或不可见' }, { status: 404 }),
    ) as unknown as typeof fetch
    const result = await requestFavorite(listingId)
    expect(result.kind).toBe('failed')
  })
})
