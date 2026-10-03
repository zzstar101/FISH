import { describe, expect, test } from 'bun:test'
import { QueryClient } from '@tanstack/react-query'
import { resetPcSession } from '../../lib/session-cache'
import { viewHistoryKeys } from './queries'

describe('view history query cache scope', () => {
  test('keys are account-scoped and under the shared pc namespace', () => {
    const keys = [viewHistoryKeys.list('owner-a'), viewHistoryKeys.total('owner-a')]
    for (const key of keys) {
      expect(key[0]).toBe('pc')
      expect(key).toContain('owner-a')
    }
    expect(viewHistoryKeys.list('owner-a')).not.toEqual(viewHistoryKeys.list('owner-b'))
    expect(viewHistoryKeys.total('owner-a')).not.toEqual(viewHistoryKeys.total('owner-b'))
  })

  test('account switch clears view history caches', async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(viewHistoryKeys.list('owner-a'), { pages: [], pageParams: [] })
    queryClient.setQueryData(viewHistoryKeys.total('owner-a'), 3)

    await resetPcSession(queryClient, null)

    expect(queryClient.getQueryData(viewHistoryKeys.list('owner-a'))).toBeUndefined()
    expect(queryClient.getQueryData(viewHistoryKeys.total('owner-a'))).toBeUndefined()
  })
})
