import { describe, expect, test } from 'bun:test'
import { ApiError } from '../../lib/api-client'
import {
  adminLoadOutcome,
  disputeResolveError,
  governanceActionError,
  moderationDecisionError,
  reportHandleError,
} from './admin-messages'

function apiError(code: string, status: number, details?: { field: string; message: string }[]) {
  return new ApiError(code, status, code, details)
}

describe('adminLoadOutcome', () => {
  test('403 FORBIDDEN 单独成权限态', () => {
    expect(adminLoadOutcome(apiError('FORBIDDEN', 403))).toEqual({ kind: 'forbidden' })
  })

  test('404 归为目标不存在', () => {
    const outcome = adminLoadOutcome(apiError('ADMIN_NOT_FOUND', 404))
    expect(outcome).toEqual({ kind: 'error', message: '目标不存在或已被删除' })
  })

  test('非 ApiError 归网络异常', () => {
    expect(adminLoadOutcome(new Error('boom'))).toEqual({
      kind: 'error',
      message: '网络异常，请稍后重试',
    })
  })
})

describe('governanceActionError', () => {
  test('GOVERNANCE_CONFLICT 标记冲突', () => {
    const outcome = governanceActionError(apiError('GOVERNANCE_CONFLICT', 409))
    expect(outcome.conflict).toBe(true)
    expect(outcome.message).toContain('已被其他管理员变更')
  })

  test('SELF_TARGET / MISMATCH 有明确文案且非冲突', () => {
    expect(governanceActionError(apiError('GOVERNANCE_SELF_TARGET', 422)).conflict).toBe(false)
    expect(
      governanceActionError(apiError('GOVERNANCE_SOURCE_REPORT_MISMATCH', 422)).message,
    ).toContain('不匹配')
  })

  test('VALIDATION_FAILED 透传 details 第一条', () => {
    const outcome = governanceActionError(
      apiError('VALIDATION_FAILED', 422, [{ field: 'reason', message: '太短' }]),
    )
    expect(outcome.message).toBe('reason：太短')
  })
})

describe('moderationDecisionError / reportHandleError', () => {
  test('两个 409 冲突码都标记 conflict', () => {
    expect(moderationDecisionError(apiError('MODERATION_CONFLICT', 409)).conflict).toBe(true)
    expect(reportHandleError(apiError('REPORT_CONFLICT', 409)).conflict).toBe(true)
  })

  test('未知错误码透传服务端 message', () => {
    expect(moderationDecisionError(apiError('INTERNAL_ERROR', 500)).message).toBe('INTERNAL_ERROR')
  })

  test('非 ApiError 归网络异常', () => {
    expect(reportHandleError(null)).toEqual({ message: '网络异常，请稍后重试', conflict: false })
  })
})

describe('disputeResolveError（#465）', () => {
  test('并发处理与终态不可撤回都标记 conflict（弹窗关闭、提示刷新）', () => {
    expect(disputeResolveError(apiError('DISPUTE_CONFLICT', 409)).conflict).toBe(true)
    expect(disputeResolveError(apiError('DISPUTE_NOT_PENDING', 409)).conflict).toBe(true)
    expect(disputeResolveError(apiError('DISPUTE_CONFLICT', 409)).message).toContain('已被处理')
  })

  test('DISPUTE_NOT_FOUND 归为目标不存在且非冲突', () => {
    expect(disputeResolveError(apiError('DISPUTE_NOT_FOUND', 404))).toEqual({
      message: '争议不存在或已被删除',
      conflict: false,
    })
  })

  test('VALIDATION_FAILED 透传 details 第一条；未知码透传 message', () => {
    expect(
      disputeResolveError(
        apiError('VALIDATION_FAILED', 422, [{ field: 'reason', message: '太短' }]),
      ).message,
    ).toBe('reason：太短')
    expect(disputeResolveError(apiError('INTERNAL_ERROR', 500)).message).toBe('INTERNAL_ERROR')
  })

  test('非 ApiError 归网络异常', () => {
    expect(disputeResolveError(new Error('boom'))).toEqual({
      message: '网络异常，请稍后重试',
      conflict: false,
    })
  })
})
