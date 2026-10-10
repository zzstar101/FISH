import { afterEach, describe, expect, mock, test } from 'bun:test'
import { ApiError } from '../../lib/api-client'
import { fetchPublicProfile, fetchUserActiveListings } from './api'

const originalFetch = globalThis.fetch

const USER_ID = 'usr_01jc000000e00800000000000a'
const LISTING_ID = 'lst_01jc000000e00800000000000t'

const profile = {
  id: USER_ID,
  nickname: '阿岚',
  avatarUrl: null,
  authStatus: 'UNVERIFIED',
  signature: null,
  joinedDays: 3,
  activeCount: 2,
  soldCount: 1,
  // 在线态（#359 第五点）在公开 DTO 里是必填：本用例不关心，给「离线」这一档。
  presence: { online: false, lastActiveAt: null },
} as const

const card = {
  id: LISTING_ID,
  title: '二手自行车',
  priceCents: 12000,
  category: 'TRANSPORT',
  condition: 'GOOD',
  status: 'ACTIVE',
  urgent: false,
  negotiable: true,
  free: false,
  coverUrl: null,
  createdAt: '2026-09-29T00:00:00.000Z',
  moderationStatus: null,
  wants: 0,
  views: 0,
} as const

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('user profile API', () => {
  test('reads the public profile from the contract route', async () => {
    const calls: string[] = []
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push(url)
      return Response.json(profile)
    }) as unknown as typeof fetch

    await expect(fetchPublicProfile(USER_ID)).resolves.toEqual(profile)
    expect(calls).toEqual([`/api/users/${USER_ID}/public`])
  })

  /**
   * 契约对「非法 id」与「不存在的用户」返回**同一个** 404：这条路径任何匿名请求都能稳定触发，
   * 区分两者等于给出一份用户 id 空间探针。端上据此渲染「用户不存在」。
   */
  test('surfaces USER_NOT_FOUND when the user does not exist', async () => {
    globalThis.fetch = mock(async () =>
      Response.json(
        { error: { code: 'USER_NOT_FOUND', message: '用户不存在或不可见' } },
        { status: 404 },
      ),
    ) as unknown as typeof fetch

    const error = await fetchPublicProfile(USER_ID).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(404)
    expect((error as ApiError).code).toBe('USER_NOT_FOUND')
  })

  test('pages the active listings with limit and, when given, the opaque cursor', async () => {
    const calls: string[] = []
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push(url)
      return Response.json({ items: [card], nextCursor: 'cur-2' })
    }) as unknown as typeof fetch

    await expect(fetchUserActiveListings(USER_ID)).resolves.toEqual({
      items: [card],
      nextCursor: 'cur-2',
    })
    await fetchUserActiveListings(USER_ID, 'cur-2')
    expect(calls).toEqual([
      `/api/users/${USER_ID}/listings?limit=20`,
      `/api/users/${USER_ID}/listings?limit=20&cursor=cur-2`,
    ])
  })
})
