import { describe, expect, test } from 'bun:test'
import { ApiErrorDetailSchema, ApiErrorSchema, errorBody, validationDetails } from './error'

describe('ApiErrorSchema', () => {
  test('still accepts the envelope used by auth and wishes (no details)', () => {
    const parsed = ApiErrorSchema.parse({ error: { code: 'UNAUTHENTICATED', message: '未登录' } })
    expect(parsed.error.details).toBeUndefined()
  })

  test('accepts field-level details for form validation', () => {
    const parsed = ApiErrorSchema.parse({
      error: {
        code: 'VALIDATION_FAILED',
        message: '参数校验失败',
        details: [{ field: 'objectKeys.1', message: '同一张图片不能重复' }],
      },
    })
    expect(parsed.error.details?.[0]?.field).toBe('objectKeys.1')
  })
})

describe('errorBody', () => {
  // 关键回归：不传 details 时，响应体必须与加第三参之前逐字节相同，
  // 否则就是替已合并的 auth / wishes 改了协议。
  test('omits the details key entirely when none is passed', () => {
    const body = errorBody('UNAUTHENTICATED', '未登录')
    expect('details' in body.error).toBe(false)
    expect(JSON.stringify(body)).toBe('{"error":{"code":"UNAUTHENTICATED","message":"未登录"}}')
  })

  test('carries details through when passed', () => {
    const body = errorBody('VALIDATION_FAILED', '参数校验失败', [
      { field: 'title', message: '标题至少 2 个字' },
    ])
    expect(body.error.details?.[0]?.field).toBe('title')
    expect(ApiErrorSchema.safeParse(body).success).toBe(true)
  })
})

describe('validationDetails', () => {
  test('joins Zod issue paths with dots, including array indices', () => {
    const details = validationDetails([
      { path: ['title'], message: '标题至少 2 个字' },
      { path: ['objectKeys', 1], message: '同一张图片不能重复' },
    ])

    expect(details).toEqual([
      { field: 'title', message: '标题至少 2 个字' },
      { field: 'objectKeys.1', message: '同一张图片不能重复' },
    ])
  })

  test('maps issues with an empty path (object-level refine) to an empty field', () => {
    expect(validationDetails([{ path: [], message: '至少提供一个要修改的字段' }])).toEqual([
      { field: '', message: '至少提供一个要修改的字段' },
    ])
  })
})

describe('ApiErrorDetailSchema', () => {
  test('requires both field and message', () => {
    expect(ApiErrorDetailSchema.safeParse({ field: 'title' }).success).toBe(false)
    expect(
      ApiErrorDetailSchema.safeParse({ field: 'title', message: '标题至少 2 个字' }).success,
    ).toBe(true)
  })
})
