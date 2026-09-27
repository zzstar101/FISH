import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fetchNotifications, fetchUnreadNotificationCount, markNotificationRead } from './api'

const originalFetch = globalThis.fetch

const notification = {
  id: 'ntf_01jc000000e00800000000002a',
  type: 'MATCH',
  payload: {
    matchId: 'mtc_01jc000000e00800000000003a',
    listingId: 'lst_01jc000000e00800000000000t',
    wishId: 'wsh_01jc000000e00800000000003t',
  },
  readAt: null,
  createdAt: '2026-09-26T00:00:00.000Z',
} as const

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('notifications API', () => {
  test('loads the capped list and unread count from the contract endpoints', async () => {
    const calls: string[] = []
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push(url)
      if (url === '/api/notifications?limit=50') {
        return Response.json({ items: [notification] })
      }
      if (url === '/api/notifications/unread-count') {
        return Response.json({ unreadCount: 3 })
      }
      return new Response(null, { status: 500 })
    }) as unknown as typeof fetch

    await expect(fetchNotifications()).resolves.toEqual({ items: [notification] })
    await expect(fetchUnreadNotificationCount()).resolves.toBe(3)
    expect(calls).toEqual(['/api/notifications?limit=50', '/api/notifications/unread-count'])
  })

  test('marks one notification read and parses the updated DTO', async () => {
    const calls: Array<{ url: string; method: string }> = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({ url, method: init?.method ?? 'GET' })
      return Response.json({ ...notification, readAt: '2026-09-26T01:00:00.000Z' })
    }) as unknown as typeof fetch

    const updated = await markNotificationRead('ntf_01jc000000e00800000000002a')
    expect(updated.readAt).toBe('2026-09-26T01:00:00.000Z')
    expect(calls).toEqual([
      { url: '/api/notifications/ntf_01jc000000e00800000000002a/read', method: 'POST' },
    ])
  })
})
