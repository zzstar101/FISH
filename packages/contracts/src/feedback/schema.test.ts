import { describe, expect, test } from 'bun:test'
import {
  AdminFeedbackHandleInputSchema,
  AdminFeedbackQueueQuerySchema,
  FeedbackCreateInputSchema,
} from './schema'

const CLIENT_REQUEST_ID = '01930000-0000-7000-8000-000000000001'

describe('FeedbackCreateInputSchema（#463）', () => {
  test('正文去空白后再判长度；多余字段被拒', () => {
    const base = { clientRequestId: CLIENT_REQUEST_ID, type: 'BUG' }
    expect(FeedbackCreateInputSchema.safeParse({ ...base, content: '  四个字  ' }).success).toBe(
      false,
    )
    expect(
      FeedbackCreateInputSchema.safeParse({ ...base, content: '一二三四五', extra: 1 }).success,
    ).toBe(false)
    expect(FeedbackCreateInputSchema.parse({ ...base, content: ' 一二三四五 ' }).content).toBe(
      '一二三四五',
    )
  })

  test('联系方式：空串 / 纯空白视为没留；超长被拒', () => {
    const base = { clientRequestId: CLIENT_REQUEST_ID, type: 'UX', content: '一二三四五' }
    expect(FeedbackCreateInputSchema.parse({ ...base, contact: '' }).contact).toBeUndefined()
    expect(FeedbackCreateInputSchema.parse({ ...base, contact: '   ' }).contact).toBeUndefined()
    expect(FeedbackCreateInputSchema.parse({ ...base, contact: ' wx_a ' }).contact).toBe('wx_a')
    expect(FeedbackCreateInputSchema.safeParse({ ...base, contact: 'x'.repeat(101) }).success).toBe(
      false,
    )
  })
})

describe('AdminFeedbackHandleInputSchema', () => {
  test('REPLIED 必须带回复，CLOSED 不能带回复，备注恒必填', () => {
    expect(AdminFeedbackHandleInputSchema.safeParse({ result: 'REPLIED', note: 'n' }).success).toBe(
      false,
    )
    expect(
      AdminFeedbackHandleInputSchema.safeParse({ result: 'CLOSED', reply: 'r', note: 'n' }).success,
    ).toBe(false)
    expect(AdminFeedbackHandleInputSchema.safeParse({ result: 'CLOSED' }).success).toBe(false)
    expect(
      AdminFeedbackHandleInputSchema.safeParse({ result: 'REPLIED', reply: 'r', note: 'n' })
        .success,
    ).toBe(true)
  })
})

describe('AdminFeedbackQueueQuerySchema', () => {
  test('筛选值走契约枚举，limit 封顶 50', () => {
    expect(AdminFeedbackQueueQuerySchema.safeParse({ status: 'DONE' }).success).toBe(false)
    expect(AdminFeedbackQueueQuerySchema.safeParse({ limit: '51' }).success).toBe(false)
    expect(AdminFeedbackQueueQuerySchema.parse({ type: 'BUG' })).toEqual({ type: 'BUG', limit: 20 })
  })
})
