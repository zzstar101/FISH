import { afterAll, describe, expect, test } from 'bun:test'
import type { Me } from '@fish/contracts/auth/user'
import { ApiError } from './api-client'
import { AUTH_ME_QUERY_KEY, currentSessionGeneration, resetPcSession } from './session-cache'

const newUser: Me = {
  id: '01930000-0000-7000-8000-00000000000b',
  nickname: '新用户',
  avatarUrl: null,
  authStatus: 'UNVERIFIED',
  verifiedAt: null,
  phoneBound: false,
  maskedPhone: null,
}

const originalWindow = globalThis.window

afterAll(() => {
  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, 'window')
    return
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
})

describe('global 401 handling', () => {
  test('a stale mutation 401 cannot clear a newer login session', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        addEventListener() {},
        location: { assign() {}, hash: '', pathname: '/pc/', search: '' },
        removeEventListener() {},
      },
    })
    const { queryClient } = await import('./query-client')

    let reject!: (error: unknown) => void
    const pending = new Promise<unknown>((_, fail) => {
      reject = fail
    })
    const staleGeneration = currentSessionGeneration()
    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: () => pending,
    })
    const running = mutation.execute(undefined).catch(() => undefined)

    await new Promise((resolve) => setTimeout(resolve, 0))
    await resetPcSession(queryClient, newUser)
    queryClient.setQueryData(['pc', 'new-user-data'], { id: 'new' })

    reject(
      new ApiError('UNAUTHENTICATED', 401, '旧会话已失效', undefined, undefined, staleGeneration),
    )
    await running
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(queryClient.getQueryData<Me>(AUTH_ME_QUERY_KEY)).toEqual(newUser)
    expect(queryClient.getQueryData<{ id: string }>(['pc', 'new-user-data'])).toEqual({ id: 'new' })
  })
})
