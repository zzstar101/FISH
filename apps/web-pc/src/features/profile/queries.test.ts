import { describe, expect, test } from 'bun:test'
import type { Me } from '@fish/contracts/auth/user'
import { QueryClient } from '@tanstack/react-query'
import { resetPcSession } from '../../lib/session-cache'
import { profileKeys } from './queries'

const oldUser: Me = {
  id: '01930000-0000-7000-8000-00000000000a',
  nickname: '旧用户',
  avatarUrl: null,
  authStatus: 'UNVERIFIED',
  verifiedAt: null,
  phoneBound: false,
  maskedPhone: null,
}

describe('profile query cache scope', () => {
  test('all profile keys are under pc and include the owner id', () => {
    const keys = [
      profileKeys.aggregate(oldUser.id),
      profileKeys.listings(oldUser.id, 'ALL'),
      profileKeys.orders(oldUser.id, 'buyer', 'ALL'),
      profileKeys.order(oldUser.id, 'tx-1'),
    ]

    for (const key of keys) {
      expect(key[0]).toBe('pc')
      expect(key).toContain(oldUser.id)
    }
    expect(profileKeys.aggregate(oldUser.id)).not.toEqual(
      profileKeys.aggregate('01930000-0000-7000-8000-00000000000b'),
    )
  })

  test('switching accounts clears profile caches with the pc namespace', async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(profileKeys.aggregate(oldUser.id), { stats: { activeListings: 9 } })
    queryClient.setQueryData(profileKeys.orders(oldUser.id, 'buyer', 'ALL'), { items: ['old'] })

    await resetPcSession(queryClient, null)

    expect(queryClient.getQueryData(profileKeys.aggregate(oldUser.id))).toBeUndefined()
    expect(queryClient.getQueryData(profileKeys.orders(oldUser.id, 'buyer', 'ALL'))).toBeUndefined()
  })
})
