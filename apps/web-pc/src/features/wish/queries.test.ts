import { describe, expect, test } from 'bun:test'
import { QueryClient } from '@tanstack/react-query'
import { resetPcSession } from '../../lib/session-cache'
import { wishKeys } from './queries'

describe('wish query cache scope', () => {
  test('keys are account-scoped and under the shared pc namespace', () => {
    const keys = [
      wishKeys.pool('owner-a'),
      wishKeys.mine('owner-a', 'ACTIVE', 1),
      wishKeys.matches('owner-a', 'wish-1'),
      wishKeys.listingMatches('owner-a', 'listing-1'),
      wishKeys.myListings('owner-a'),
    ]
    for (const key of keys) {
      expect(key[0]).toBe('pc')
      expect(key).toContain('owner-a')
    }
    expect(wishKeys.mine('owner-a', 'ACTIVE', 1)).not.toEqual(wishKeys.mine('owner-b', 'ACTIVE', 1))
    expect(wishKeys.mine('owner-a', 'ACTIVE', 1)).not.toEqual(wishKeys.mine('owner-a', 'ACTIVE', 2))
  })

  test('account switch clears wish and match caches', async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(wishKeys.mine('owner-a', 'ACTIVE', 1), [{ id: 'wish-1' }])
    queryClient.setQueryData(wishKeys.matches('owner-a', 'wish-1'), { total: 1, items: [] })

    await resetPcSession(queryClient, null)

    expect(queryClient.getQueryData(wishKeys.mine('owner-a', 'ACTIVE', 1))).toBeUndefined()
    expect(queryClient.getQueryData(wishKeys.matches('owner-a', 'wish-1'))).toBeUndefined()
  })
})
