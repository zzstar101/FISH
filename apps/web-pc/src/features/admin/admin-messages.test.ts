import { describe, expect, test } from 'bun:test'
import { ApiError } from '../../lib/api-client'
import {
  adminLoadOutcome,
  adminLoadView,
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

  test('404 归为目标不存在（notFound：界面给「返回列表」，不再摆一个救不回的重试）', () => {
    expect(adminLoadOutcome(apiError('ADMIN_NOT_FOUND', 404))).toEqual({ kind: 'notFound' })
    expect(adminLoadOutcome(apiError('REPORT_NOT_FOUND', 404))).toEqual({ kind: 'notFound' })
  })

  test('非 ApiError 归网络异常', () => {
    expect(adminLoadOutcome(new Error('boom'))).toEqual({
      kind: 'error',
      message: '网络异常，请稍后重试',
    })
  })
})

describe('adminLoadView（失败态 → 渲染指令，#467 五审 P3）', () => {
  test('403 归权限态、404 归缺失态：都不带可展示文案（页面据此不摆重试）', () => {
    expect(adminLoadView(apiError('FORBIDDEN', 403), '加载失败')).toEqual({ kind: 'forbidden' })
    expect(adminLoadView(apiError('ADMIN_NOT_FOUND', 404), '加载失败')).toEqual({
      kind: 'notFound',
    })
  })

  test('其它错误保留服务端文案（唯一带「重试」的一类）', () => {
    expect(adminLoadView(apiError('INTERNAL_ERROR', 500), '加载失败')).toEqual({
      kind: 'error',
      message: 'INTERNAL_ERROR',
    })
  })

  test('非 ApiError 用网络异常文案，不落到兜底', () => {
    expect(adminLoadView(new Error('boom'), '加载失败')).toEqual({
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
