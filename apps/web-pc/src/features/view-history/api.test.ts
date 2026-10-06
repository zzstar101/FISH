import { afterEach, describe, expect, mock, test } from 'bun:test'
import { clearMyViewHistory, fetchMyViewHistory, myViewHistoryPath } from './api'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const listingId = 'lst_01jc000000e00800000000000k'

describe('myViewHistoryPath', () => {
  test('恒带 limit，cursor 缺省不带', () => {
    expect(myViewHistoryPath({ limit: 20 })).toBe('/me/view-history?limit=20')
  })

  test('翻页时把上一页的 nextCursor 原样带上', () => {
    expect(myViewHistoryPath({ limit: 20, cursor: 'abc+/=' })).toBe(
      '/me/view-history?limit=20&cursor=abc%2B%2F%3D',
    )
  })
})

describe('fetchMyViewHistory', () => {
  test('GET /me/view-history 并用契约收口响应', async () => {
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
              createdAt: '2026-01-01T00:00:00.000Z',
              moderationStatus: null,
            },
            viewedAt: '2026-10-02T01:00:00.000Z',
          },
        ],
        nextCursor: null,
        total: 1,
      })
    }) as unknown as typeof fetch

    const page = await fetchMyViewHistory({ limit: 20 })

    expect(calls).toEqual([{ url: '/api/me/view-history?limit=20', method: 'GET' }])
    expect(page.items[0]?.listing.status).toBe('SOLD')
    expect(page.total).toBe(1)
  })
})

describe('clearMyViewHistory', () => {
  test('DELETE 并把删除行数按契约收口', async () => {
    const calls: Array<{ url: string; method: string }> = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({ url, method: init?.method ?? 'GET' })
      return Response.json({ deleted: 3 })
    }) as unknown as typeof fetch

    expect(await clearMyViewHistory()).toEqual({ deleted: 3 })
    expect(calls).toEqual([{ url: '/api/me/view-history', method: 'DELETE' }])
  })
})
