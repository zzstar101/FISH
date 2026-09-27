import { describe, expect, test } from 'bun:test'
import type { Me } from '@fish/contracts/auth/user'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { AUTH_ME_QUERY_KEY, resetPcSession } from './session-cache'

const user: Me = {
  id: 'usr_01jc000000e00800000000000a',
  nickname: '阿岚',
  avatarUrl: null,
  authStatus: 'UNVERIFIED',
  verifiedAt: null,
  phoneBound: false,
  maskedPhone: null,
}

describe('resetPcSession', () => {
  test('clears pc queries, preserves other keys and writes the current user', async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData<Array<{ id: string }>>(
      ['pc', 'listings', 'search', { q: '旧账号' }],
      [{ id: 'old' }],
    )
    queryClient.setQueryData<string>(['other', 'cache'], 'keep')

    await resetPcSession(queryClient, user)

    expect(
      queryClient.getQueryData<Array<{ id: string }>>([
        'pc',
        'listings',
        'search',
        { q: '旧账号' },
      ]),
    ).toBeUndefined()
    expect(queryClient.getQueryData<string>(['other', 'cache'])).toBe('keep')
    expect(queryClient.getQueryData<Me>(AUTH_ME_QUERY_KEY)).toEqual(user)
  })

  test('clears a mounted detail immediately and refetches it for the new account', async () => {
    const queryClient = new QueryClient()
    const detailKey = ['pc', 'listings', 'detail', 'listing']
    queryClient.setQueryData(detailKey, { owner: 'A' })
    queryClient.setQueryData(AUTH_ME_QUERY_KEY, {
      ...user,
      id: 'usr_01jc000000e00800000000000b',
    })

    let resolveNew!: (value: { owner: string }) => void
    let fetches = 0
    const observer = new QueryObserver(queryClient, {
      queryKey: detailKey,
      staleTime: Infinity,
      queryFn: () => {
        fetches += 1
        return new Promise<{ owner: string }>((resolve) => {
          resolveNew = resolve
        })
      },
    })
    const observed: Array<string | undefined> = []
    let resolveRendered!: (owner: string) => void
    const rendered = new Promise<string>((resolve) => {
      resolveRendered = resolve
    })
    const unsubscribe = observer.subscribe((result) => {
      observed.push(result.data?.owner)
      if (result.data?.owner === 'B') resolveRendered('B')
    })
    try {
      expect(observer.getCurrentResult().data?.owner).toBe('A')
      await resetPcSession(queryClient, user, { cancelAuth: false })
      expect(observer.getCurrentResult().data).toBeUndefined()
      expect(observed).toContain(undefined)
      expect(fetches).toBe(1)
      resolveNew({ owner: 'B' })
      expect(await rendered).toBe('B')
      expect(observer.getCurrentResult().data?.owner).toBe('B')
    } finally {
      unsubscribe()
    }
  })

  test('discards an in-flight A detail and shows only the refetched B detail', async () => {
    const queryClient = new QueryClient()
    const detailKey = ['pc', 'listings', 'detail', 'listing']
    let resolveOld!: (value: { owner: string }) => void
    let resolveNew!: (value: { owner: string }) => void
    let fetches = 0
    const observer = new QueryObserver(queryClient, {
      queryKey: detailKey,
      retry: false,
      queryFn: () => {
        fetches += 1
        return new Promise<{ owner: string }>((resolve) => {
          if (fetches === 1) resolveOld = resolve
          else resolveNew = resolve
        })
      },
    })
    const observed: Array<string | undefined> = []
    let resolveRendered!: (owner: string) => void
    const rendered = new Promise<string>((resolve) => {
      resolveRendered = resolve
    })
    const unsubscribe = observer.subscribe((result) => {
      observed.push(result.data?.owner)
      if (result.data?.owner === 'B') resolveRendered('B')
    })
    try {
      expect(fetches).toBe(1)
      await resetPcSession(queryClient, user, { cancelAuth: false })
      expect(fetches).toBe(2)
      resolveOld({ owner: 'A' })
      await Promise.resolve()
      expect(observer.getCurrentResult().data).toBeUndefined()
      resolveNew({ owner: 'B' })
      expect(await rendered).toBe('B')
      expect(observed).not.toContain('A')
    } finally {
      unsubscribe()
    }
  })

  test('cancels an in-flight auth query before writing the new session', async () => {
    const queryClient = new QueryClient()
    let resolveOldRequest!: (value: Me) => void
    const pending = new Promise<Me>((resolve) => {
      resolveOldRequest = resolve
    })
    const oldRequest = queryClient.fetchQuery({
      queryKey: AUTH_ME_QUERY_KEY,
      queryFn: () => pending,
    })

    await resetPcSession(queryClient, user)
    resolveOldRequest({
      ...user,
      id: 'usr_01jc000000e00800000000000b',
      nickname: '旧用户',
    })
    await oldRequest.catch(() => undefined)

    expect(queryClient.getQueryData<Me>(AUTH_ME_QUERY_KEY)).toEqual(user)
  })

  test('does not refetch active business data after logout', async () => {
    const queryClient = new QueryClient()
    const detailKey = ['pc', 'listings', 'detail', 'listing']
    queryClient.setQueryData(detailKey, { owner: 'A' })
    let fetches = 0
    const observer = new QueryObserver(queryClient, {
      queryKey: detailKey,
      staleTime: Infinity,
      queryFn: async () => {
        fetches += 1
        return { owner: 'A' }
      },
    })
    const unsubscribe = observer.subscribe(() => undefined)
    try {
      await resetPcSession(queryClient, null)
      expect(queryClient.getQueryData(detailKey)).toBeUndefined()
      expect(fetches).toBe(0)
      expect(queryClient.getQueryData<Me | null>(AUTH_ME_QUERY_KEY)).toBeNull()
    } finally {
      unsubscribe()
    }
  })

  test('writes null when logging out', async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData<{ id: string }>(['pc', 'listings', 'detail', 'old'], { id: 'old' })
    queryClient.setQueryData<Me>(AUTH_ME_QUERY_KEY, user)

    await resetPcSession(queryClient, null)

    expect(
      queryClient.getQueryData<{ id: string }>(['pc', 'listings', 'detail', 'old']),
    ).toBeUndefined()
    expect(queryClient.getQueryData<Me | null>(AUTH_ME_QUERY_KEY)).toBeNull()
  })
})
