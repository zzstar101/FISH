import { describe, expect, test } from 'bun:test'
import type { Me } from '@fish/contracts/auth/user'
import { QueryClient } from '@tanstack/react-query'
import { AUTH_ME_QUERY_KEY, resetPcSession } from './session-cache'

const user: Me = {
  id: '01930000-0000-7000-8000-00000000000a',
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
      id: '01930000-0000-7000-8000-00000000000b',
      nickname: '旧用户',
    })
    await oldRequest.catch(() => undefined)

    expect(queryClient.getQueryData<Me>(AUTH_ME_QUERY_KEY)).toEqual(user)
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
