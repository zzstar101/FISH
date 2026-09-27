import { describe, expect, test } from 'bun:test'
import { ApiError } from '../../lib/api-client'
import { describeAuthFailure } from './error-messages'

describe('describeAuthFailure', () => {
  test('VALIDATION_FAILED 带 details 时定位到具体字段，而不是只显示泛化文案', () => {
    const error = new ApiError('VALIDATION_FAILED', 422, '请求参数不合法', [
      { field: 'password', message: '密码至少 8 个字符' },
    ])

    expect(describeAuthFailure(error)).toEqual({
      fieldErrors: { password: '密码至少 8 个字符' },
    })
  })
})
