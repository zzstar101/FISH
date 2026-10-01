import { afterEach, describe, expect, mock, test } from 'bun:test'
import { ApiError } from '../../lib/api-client'
import { chatWatchersPath, fetchChatWatchers, WATCHERS_PAGE_LIMIT, watchersLoadError } from './api'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('chatWatchersPath', () => {
  test('恒带 limit（契约默认 20），cursor 缺省不带', () => {
    expect(WATCHERS_PAGE_LIMIT).toBe(20)
    expect(chatWatchersPath('lst_01jc000000e00800000000000t')).toBe(
      '/listings/lst_01jc000000e00800000000000t/watchers?limit=20',
    )
  })

  test('翻页时把上一页的 nextCursor 原样带上', () => {
    expect(chatWatchersPath('lst_01jc000000e00800000000000t', 'abc+/=')).toBe(
      '/listings/lst_01jc000000e00800000000000t/watchers?limit=20&cursor=abc%2B%2F%3D',
    )
  })
})

describe('fetchChatWatchers', () => {
  test('GET /listings/:id/watchers 并用契约收口响应', async () => {
    const calls: Array<{ url: string; method: string }> = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({ url, method: init?.method ?? 'GET' })
      return Response.json({
        items: [
          {
            user: {
              id: 'usr_01jc000000e00800000000001a',
              nickname: '小北',
              avatarUrl: null,
              authStatus: 'UNVERIFIED',
            },
            startedAt: '2026-09-30T10:00:00.000Z',
          },
        ],
        nextCursor: null,
        total: 1,
      })
      // Bun 的 `fetch` 类型带 `preconnect` 等静态属性，`mock()` 造不出，按仓内惯例收口。
    }) as unknown as typeof fetch

    const result = await fetchChatWatchers('lst_01jc000000e00800000000000t')

    expect(calls).toEqual([
      { url: '/api/listings/lst_01jc000000e00800000000000t/watchers?limit=20', method: 'GET' },
    ])
    expect(result.total).toBe(1)
    expect(result.nextCursor).toBeNull()
    expect(result.items[0]?.user.nickname).toBe('小北')
  })

  test('响应形状漂移在进 UI 前暴露', async () => {
    globalThis.fetch = mock(async () => Response.json({ items: 'oops' })) as unknown as typeof fetch
    await expect(fetchChatWatchers('lst_01jc000000e00800000000000t')).rejects.toThrow()
  })
})

describe('watchersLoadError', () => {
  test('404 LISTING_NOT_FOUND 是业务边界（商品不存在），不是系统错误', () => {
    const outcome = watchersLoadError(new ApiError('LISTING_NOT_FOUND', 404, '商品不存在'))
    expect(outcome).toEqual({ kind: 'listing-missing' })
  })

  test('403 NOT_LISTING_OWNER 是业务边界（不是卖家），不是系统错误', () => {
    // Issue 原文写「非卖家落到 404」，服务端实现是 403 —— 两种都必须按业务空态渲染。
    const outcome = watchersLoadError(
      new ApiError('NOT_LISTING_OWNER', 403, '只能查看自己商品的想要的人'),
    )
    expect(outcome).toEqual({ kind: 'not-owner' })
  })

  test('其余 ApiError（网络外的原因）带服务端 message 落成可重试错误', () => {
    const outcome = watchersLoadError(new ApiError('INTERNAL_ERROR', 500, '请求失败，请稍后重试'))
    expect(outcome).toEqual({ kind: 'error', message: '请求失败，请稍后重试' })
  })

  test('非 ApiError（网络挂了等）落成统一的可重试文案', () => {
    expect(watchersLoadError(new TypeError('fetch failed'))).toEqual({
      kind: 'error',
      message: '网络异常，请稍后重试',
    })
  })
})
