import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  fetchFollowState,
  fetchMyFollowing,
  followRelationPath,
  myFollowingPath,
  requestFollow,
  requestUnfollow,
} from './api'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const userId = 'usr_01jc000000e00800000000000c'

describe('myFollowingPath', () => {
  test('恒带 limit，cursor 缺省不带', () => {
    expect(myFollowingPath({ limit: 20 })).toBe('/me/following?limit=20')
  })

  test('翻页时把上一页的 nextCursor 原样带上', () => {
    expect(myFollowingPath({ limit: 20, cursor: 'abc+/=' })).toBe(
      '/me/following?limit=20&cursor=abc%2B%2F%3D',
    )
  })
})

describe('followRelationPath', () => {
  test('规范用户 ID 原样进路径', () => {
    expect(followRelationPath(userId)).toBe(`/users/${userId}/follow`)
  })

  test('非规范 ID（uuid / 裸数字）不拼 URL，直接判不可用', () => {
    expect(followRelationPath('3f9d1c2e-0000-4000-8000-000000000000')).toBeNull()
    expect(followRelationPath('1234567890')).toBeNull()
  })
})

describe('fetchFollowState', () => {
  test('GET 关注关系并用契约收口响应', async () => {
    const calls: Array<{ url: string; method: string }> = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({ url, method: init?.method ?? 'GET' })
      return Response.json({ following: true, mutual: true })
    }) as unknown as typeof fetch

    const outcome = await fetchFollowState(userId)

    expect(calls).toEqual([{ url: `/api/users/${userId}/follow`, method: 'GET' }])
    expect(outcome).toEqual({ kind: 'loaded', following: true, mutual: true })
  })

  test('404 USER_NOT_FOUND 收口成 notFound（降级「无法关注」，不冒充网络失败）', async () => {
    globalThis.fetch = mock(async () =>
      Response.json(
        { error: { code: 'USER_NOT_FOUND', message: '用户不存在或不可见' } },
        { status: 404 },
      ),
    ) as unknown as typeof fetch

    expect(await fetchFollowState(userId)).toEqual({ kind: 'notFound' })
  })

  test('其它失败收口成 failed，保留服务端文案', async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ error: { code: 'INTERNAL_ERROR', message: '服务异常' } }, { status: 500 }),
    ) as unknown as typeof fetch

    expect(await fetchFollowState(userId)).toEqual({ kind: 'failed', message: '服务异常' })
  })

  test('非规范 ID 直接 notFound，不发请求', async () => {
    expect(await fetchFollowState('not-an-id')).toEqual({ kind: 'notFound' })
  })
})

describe('writes', () => {
  test('POST / DELETE 都回服务端状态，端上直接采用', async () => {
    const calls: Array<{ url: string; method: string }> = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({ url, method: init?.method ?? 'GET' })
      return Response.json({ following: true, mutual: false })
    }) as unknown as typeof fetch

    expect(await requestFollow(userId)).toEqual({ kind: 'written', following: true, mutual: false })
    expect(await requestUnfollow(userId)).toEqual({
      kind: 'written',
      following: true,
      mutual: false,
    })
    expect(calls.map((call) => call.method)).toEqual(['POST', 'DELETE'])
  })

  test('写失败不抛错，回 failed 保留文案（CANNOT_FOLLOW_SELF 422 也走这里）', async () => {
    globalThis.fetch = mock(async () =>
      Response.json(
        { error: { code: 'CANNOT_FOLLOW_SELF', message: '不能关注自己' } },
        { status: 422 },
      ),
    ) as unknown as typeof fetch

    expect(await requestFollow(userId)).toEqual({ kind: 'failed', message: '不能关注自己' })
  })
})

describe('fetchMyFollowing', () => {
  test('GET /me/following 并用契约收口响应', async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        items: [
          {
            id: userId,
            nickname: '橙子',
            avatarUrl: null,
            authStatus: 'VERIFIED',
            mutual: true,
          },
        ],
        nextCursor: 'cursor-1',
        total: 3,
        mutualTotal: 1,
      }),
    ) as unknown as typeof fetch

    const response = await fetchMyFollowing({ limit: 20 })

    expect(response.items).toHaveLength(1)
    expect(response.total).toBe(3)
    expect(response.mutualTotal).toBe(1)
    expect(response.nextCursor).toBe('cursor-1')
  })
})
