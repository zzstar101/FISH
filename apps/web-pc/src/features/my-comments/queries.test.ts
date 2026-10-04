import { describe, expect, test } from 'bun:test'
import { QueryClient } from '@tanstack/react-query'
import { resetPcSession } from '../../lib/session-cache'
import { myCommentsKeys } from './queries'

describe('my comments query cache scope', () => {
  test('keys are account-scoped and kind-scoped under the shared pc namespace', () => {
    const keys = [
      myCommentsKeys.list('owner-a', 'comment'),
      myCommentsKeys.list('owner-a', 'review'),
    ]
    for (const key of keys) {
      expect(key[0]).toBe('pc')
      expect(key).toContain('owner-a')
    }
    expect(myCommentsKeys.list('owner-a', 'comment')).not.toEqual(
      myCommentsKeys.list('owner-b', 'comment'),
    )
    expect(myCommentsKeys.list('owner-a', 'comment')).not.toEqual(
      myCommentsKeys.list('owner-a', 'review'),
    )
  })

  test('account switch clears my comments caches', async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(myCommentsKeys.list('owner-a', 'comment'), {
      pages: [],
      pageParams: [],
    })
    queryClient.setQueryData(myCommentsKeys.list('owner-a', 'review'), {
      pages: [],
      pageParams: [],
    })

    await resetPcSession(queryClient, null)

    expect(queryClient.getQueryData(myCommentsKeys.list('owner-a', 'comment'))).toBeUndefined()
    expect(queryClient.getQueryData(myCommentsKeys.list('owner-a', 'review'))).toBeUndefined()
  })
})
