import { describe, expect, test } from 'bun:test'
import { canReportUser, shortReportId, submitFailureText, submitSuccessText } from './view'

describe('report submit feedback', () => {
  test('maps every contract error code to its own copy', () => {
    expect(submitFailureText('REPORT_TARGET_NOT_FOUND')).toBe('被举报的内容已不存在，无法提交举报')
    expect(submitFailureText('REPORT_SELF_TARGET')).toBe('不能举报自己')
    expect(submitFailureText('REPORT_CONFLICT')).toBe('这条举报的状态刚变过，请稍后再试')
    expect(submitFailureText('UNAUTHENTICATED')).toBe('登录已过期，请重新登录后再提交')
  })

  test('falls back for unknown codes and for non-ApiError failures', () => {
    // 契约解析失败 / 网络层失败都给同一句，不把「前后端漂移」说成「你没网」。
    expect(submitFailureText(null)).toBe('提交失败，请稍后再试')
    expect(submitFailureText('SOMETHING_NEW')).toBe('提交失败，请稍后再试')
  })

  test('a duplicate report reads as already accepted, never as a failure', () => {
    expect(submitSuccessText(true)).toContain('举报已提交')
    expect(submitSuccessText(false)).toContain('无需重复提交')
  })
})

describe('canReportUser', () => {
  test('blocks reporting yourself', () => {
    expect(canReportUser('usr_01jc000000e00800000000000a', 'usr_01jc000000e00800000000000a')).toBe(
      false,
    )
  })

  test('allows reporting someone else', () => {
    expect(canReportUser('usr_01jc000000e00800000000000a', 'usr_01jc000000e00800000000000b')).toBe(
      true,
    )
  })

  test('allows it while the viewer is anonymous — the login wall is the button’s job', () => {
    expect(canReportUser(null, 'usr_01jc000000e00800000000000b')).toBe(true)
  })
})

describe('shortReportId', () => {
  test('leaves ids at or under 14 characters alone and elides the middle of longer ones', () => {
    expect(shortReportId('rpt_01J8ZQ3XK7')).toBe('rpt_01J8ZQ3XK7')
    expect(shortReportId('rpt_01J8ZQ3XK7M2ABCDEF')).toBe('rpt_01J8Z…CDEF')
  })
})
