import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { Me } from '@fish/contracts/auth/user'
import { focusManager, QueryClient, QueryObserver } from '@tanstack/react-query'
import {
  AUTH_ME_QUERY_KEY,
  currentSessionGeneration,
  resetPcSession,
} from '../../lib/session-cache'
import { loadMe, meQueryOptions } from './queries'

const originalFetch = globalThis.fetch
const oldUser: Me = {
  id: '01930000-0000-7000-8000-00000000000a',
  nickname: '旧用户',
  avatarUrl: null,
  authStatus: 'UNVERIFIED',
  verifiedAt: null,
  phoneBound: false,
  maskedPhone: null,
}
const newUser: Me = {
  ...oldUser,
  id: '01930000-0000-7000-8000-00000000000b',
  nickname: '新用户',
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('loadMe', () => {
  test('initial /me success keeps public pc queries mounted before auth resolves', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ user: newUser }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch
    const queryClient = new QueryClient()
    queryClient.setQueryData(['pc', 'listings', 'detail', 'public'], { id: 'public' })

    await expect(loadMe(queryClient)).resolves.toEqual(newUser)

    expect(
      queryClient.getQueryData<{ id: string }>(['pc', 'listings', 'detail', 'public']),
    ).toEqual({
      id: 'public',
    })
    expect(queryClient.getQueryData<Me>(AUTH_ME_QUERY_KEY)).toEqual(newUser)
  })

  test('initial /me 401 keeps public pc queries mounted before auth resolves', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: 'UNAUTHENTICATED', message: '未登录' },
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof fetch
    const queryClient = new QueryClient()
    queryClient.setQueryData(['pc', 'comments', 'listing', 'public'], { items: [] })

    await expect(loadMe(queryClient)).resolves.toBeNull()

    expect(
      queryClient.getQueryData<{ items: unknown[] }>(['pc', 'comments', 'listing', 'public']),
    ).toEqual({ items: [] })
    expect(queryClient.getQueryData(AUTH_ME_QUERY_KEY)).toBeNull()
  })
  test('a successful /me identity switch clears the previous account cache before publishing B', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ user: newUser }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch
    const queryClient = new QueryClient()
    queryClient.setQueryData(AUTH_ME_QUERY_KEY, oldUser)
    queryClient.setQueryData(['pc', 'listing', 'detail'], { owner: 'A' })

    const generation = currentSessionGeneration()
    await expect(loadMe(queryClient)).resolves.toEqual(newUser)
    expect(queryClient.getQueryData<Me>(AUTH_ME_QUERY_KEY)).toEqual(newUser)
    expect(queryClient.getQueryData(['pc', 'listing', 'detail'])).toBeUndefined()
    expect(currentSessionGeneration()).toBe(generation + 1)
  })

  test('returning to a PC tab revalidates fresh /me and replaces A with B', async () => {
    let resolveResponse!: (response: Response) => void
    let fetches = 0
    globalThis.fetch = mock(async () => {
      fetches += 1
      return new Promise<Response>((resolve) => {
        resolveResponse = resolve
      })
    }) as unknown as typeof fetch
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    })
    queryClient.setQueryData(AUTH_ME_QUERY_KEY, oldUser)
    queryClient.setQueryData(['pc', 'listing', 'detail'], { owner: 'A' })
    focusManager.setFocused(false)
    queryClient.mount()
    const observer = new QueryObserver(queryClient, meQueryOptions(queryClient))
    let resolveNewUser!: (user: Me) => void
    const newUserShown = new Promise<Me>((resolve) => {
      resolveNewUser = resolve
    })
    const unsubscribe = observer.subscribe((result) => {
      if (result.data?.id === newUser.id) resolveNewUser(result.data)
    })
    try {
      expect(observer.getCurrentResult().data?.id).toBe(oldUser.id)
      focusManager.setFocused(true)
      // QueryClient 在处理焦点事件前会先 await resumePausedMutations()。
      await Promise.resolve()
      expect(observer.getCurrentResult().isFetching).toBe(true)
      expect(fetches).toBe(1)
      resolveResponse(
        new Response(JSON.stringify({ user: newUser }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      expect((await newUserShown).id).toBe(newUser.id)
      expect(queryClient.getQueryData(['pc', 'listing', 'detail'])).toBeUndefined()
    } finally {
      unsubscribe()
      queryClient.unmount()
      focusManager.setFocused(undefined)
    }
  })

  test('a successful /me refresh for the same identity keeps business cache', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ user: oldUser }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch
    const queryClient = new QueryClient()
    queryClient.setQueryData(AUTH_ME_QUERY_KEY, oldUser)
    queryClient.setQueryData(['pc', 'listing', 'detail'], { owner: 'A' })

    const generation = currentSessionGeneration()
    await expect(loadMe(queryClient)).resolves.toEqual(oldUser)
    expect(queryClient.getQueryData<{ owner: string }>(['pc', 'listing', 'detail'])).toEqual({
      owner: 'A',
    })
    expect(currentSessionGeneration()).toBe(generation)
  })

  test('a late successful /me from a previous session cannot publish the old identity', async () => {
    let resolveRequest!: (response: Response) => void
    globalThis.fetch = mock(
      async () =>
        new Promise<Response>((resolve) => {
          resolveRequest = resolve
        }),
    ) as unknown as typeof fetch
    const queryClient = new QueryClient()
    queryClient.setQueryData(AUTH_ME_QUERY_KEY, oldUser)
    const oldLoad = loadMe(queryClient)
    await resetPcSession(queryClient, newUser)
    queryClient.setQueryData(['pc', 'listing', 'detail'], { owner: 'B' })
    resolveRequest(
      new Response(JSON.stringify({ user: oldUser }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    await expect(oldLoad).resolves.toEqual(newUser)
    expect(queryClient.getQueryData<Me>(AUTH_ME_QUERY_KEY)).toEqual(newUser)
    expect(queryClient.getQueryData<{ owner: string }>(['pc', 'listing', 'detail'])).toEqual({
      owner: 'B',
    })
  })
  test('a /me 401 clears pc data and writes an unauthenticated session', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: 'UNAUTHENTICATED', message: '未登录' },
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof fetch

    const queryClient = new QueryClient()
    queryClient.setQueryData<Array<{ id: string }>>(['pc', 'listings', 'home'], [{ id: 'old' }])
    queryClient.setQueryData<Me>(AUTH_ME_QUERY_KEY, oldUser)

    await expect(loadMe(queryClient)).resolves.toBeNull()

    expect(queryClient.getQueryData(['pc', 'listings', 'home'])).toBeUndefined()
    expect(queryClient.getQueryData(AUTH_ME_QUERY_KEY)).toBeNull()
  })

  test('a stale /me 401 cannot clear a newer login session', async () => {
    let resolveRequest!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => {
      resolveRequest = resolve
    })
    globalThis.fetch = mock(async () => pending) as unknown as typeof fetch

    const queryClient = new QueryClient()
    const oldLoad = loadMe(queryClient)

    await resetPcSession(queryClient, newUser)
    queryClient.setQueryData<Array<{ id: string }>>(['pc', 'listings', 'home'], [{ id: 'new' }])
    resolveRequest(
      new Response(
        JSON.stringify({
          error: { code: 'UNAUTHENTICATED', message: '旧会话已失效' },
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      ),
    )

    await expect(oldLoad).resolves.toBeNull()
    expect(queryClient.getQueryData<Me>(AUTH_ME_QUERY_KEY)).toEqual(newUser)
    expect(queryClient.getQueryData<Array<{ id: string }>>(['pc', 'listings', 'home'])).toEqual([
      { id: 'new' },
    ])
  })
})
