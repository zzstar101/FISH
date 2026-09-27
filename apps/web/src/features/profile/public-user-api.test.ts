import { afterEach, expect, mock, test } from 'bun:test'
import { fetchPublicUser, fetchPublicUserListings } from './public-user-api'

const originalFetch = globalThis.fetch
const userId = 'usr_01jc000000e00800000000000a'

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('公开用户详情仅请求规范 usr_ ID，404 返回空态', async () => {
  let requests = 0
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    requests += 1
    expect(String(input)).toBe(`/api/users/${userId}/public`)
    return Response.json({ error: { code: 'USER_NOT_FOUND', message: '不存在' } }, { status: 404 })
  }) as unknown as typeof fetch

  await expect(fetchPublicUser('01930000-0000-7000-8000-00000000000a')).resolves.toBeNull()
  await expect(fetchPublicUser('lst_01jc000000e00800000000000k')).resolves.toBeNull()
  expect(requests).toBe(0)
  await expect(fetchPublicUser(userId)).resolves.toBeNull()
  expect(requests).toBe(1)
})

test('公开用户资料与在售列表走真实 API 并解析公开 TypeID', async () => {
  const seen: string[] = []
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input)
    seen.push(url)
    return Response.json(
      url.includes('/listings?')
        ? { items: [], nextCursor: 'next+/=' }
        : {
            id: userId,
            nickname: '阿岚',
            avatarUrl: null,
            authStatus: 'VERIFIED',
            joinedDays: 15,
            activeCount: 2,
            soldCount: 1,
          },
    )
  }) as unknown as typeof fetch

  expect((await fetchPublicUser(userId))?.id).toBe(userId)
  expect((await fetchPublicUserListings(userId, 'prev+/=')).nextCursor).toBe('next+/=')
  expect(seen).toEqual([
    `/api/users/${userId}/public`,
    `/api/users/${userId}/listings?limit=20&cursor=prev%2B%2F%3D`,
  ])
})
