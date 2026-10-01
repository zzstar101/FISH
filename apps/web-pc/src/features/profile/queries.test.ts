import { describe, expect, test } from 'bun:test'
import type { Me } from '@fish/contracts/auth/user'
import { QueryClient } from '@tanstack/react-query'
import { resetPcSession } from '../../lib/session-cache'
import { invalidateTransactionSurfaces, profileKeys } from './queries'

const oldUser: Me = {
  id: 'usr_01jc000000e00800000000000a',
  nickname: '旧用户',
  avatarUrl: null,
  authStatus: 'UNVERIFIED',
  verifiedAt: null,
  phoneBound: false,
  maskedPhone: null,
  signature: null,
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
      profileKeys.aggregate('usr_01jc000000e00800000000000b'),
    )
  })

  test('transaction invalidation refreshes my listings and chat surfaces', async () => {
    const queryClient = new QueryClient()
    const listingsKey = profileKeys.listings(oldUser.id, 'ALL')
    const chatKey = ['pc', 'chat', 'unread-count', oldUser.id] as const
    queryClient.setQueryData(listingsKey, {
      items: [{ id: 'lst_01jc000000e00800000000000t', status: 'RESERVED' }],
    })
    queryClient.setQueryData(chatKey, 1)

    invalidateTransactionSurfaces(queryClient, oldUser.id)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(queryClient.getQueryCache().find({ queryKey: listingsKey })?.state.isInvalidated).toBe(
      true,
    )
    expect(queryClient.getQueryCache().find({ queryKey: chatKey })?.state.isInvalidated).toBe(true)
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
