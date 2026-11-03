import { describe, expect, test } from 'bun:test'
import { QueryClient } from '@tanstack/react-query'
import { ApiError } from '../../lib/api-client'
import { currentSessionGeneration } from '../../lib/session-cache'
import { disputeKeys, invalidateDisputeAfterWriteFailure } from './queries'

const DISPUTE_ID = 'dsp_01jc000000e00800000000000a'

function clientWithCachedDetail() {
  const queryClient = new QueryClient()
  queryClient.setQueryData(disputeKeys.detail(DISPUTE_ID), { id: DISPUTE_ID })
  return queryClient
}

describe('invalidateDisputeAfterWriteFailure', () => {
  test('终态类错误让详情失效，页面重取权威状态', () => {
    for (const code of [
      'DISPUTE_NOT_PENDING',
      'DISPUTE_CONFLICT',
      'DISPUTE_ATTACHMENT_LIMIT',
    ] as const) {
      const queryClient = clientWithCachedDetail()
      invalidateDisputeAfterWriteFailure(
        queryClient,
        DISPUTE_ID,
        currentSessionGeneration(),
        new ApiError(code, 409, 'stale'),
      )
      expect(queryClient.getQueryState(disputeKeys.detail(DISPUTE_ID))?.isInvalidated).toBe(true)
    }
  })

  test('非终态错误不改缓存状态', () => {
    const queryClient = clientWithCachedDetail()
    invalidateDisputeAfterWriteFailure(
      queryClient,
      DISPUTE_ID,
      currentSessionGeneration(),
      new ApiError('DISPUTE_NOT_FOUND', 404, 'gone'),
    )
    expect(queryClient.getQueryState(disputeKeys.detail(DISPUTE_ID))?.isInvalidated).toBe(false)
  })

  test('已切号（代际不一致）时不做任何缓存操作', () => {
    const queryClient = clientWithCachedDetail()
    invalidateDisputeAfterWriteFailure(
      queryClient,
      DISPUTE_ID,
      currentSessionGeneration() + 1,
      new ApiError('DISPUTE_CONFLICT', 409, 'stale'),
    )
    expect(queryClient.getQueryState(disputeKeys.detail(DISPUTE_ID))?.isInvalidated).toBe(false)
  })
})
