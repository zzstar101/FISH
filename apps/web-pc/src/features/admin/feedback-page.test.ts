import { describe, expect, test } from 'bun:test'
import { validateFeedbackHandle } from './feedback-handle-dialog'
import { parseFeedbackSearch } from './feedback-page'

describe('反馈队列 URL 归一（#463）', () => {
  test('缺省 = 待处理；ALL 显式保留；非法值丢弃', () => {
    expect(parseFeedbackSearch({})).toEqual({ status: 'PENDING' })
    expect(parseFeedbackSearch({ status: 'ALL', type: 'BUG' })).toEqual({
      status: 'ALL',
      type: 'BUG',
    })
    expect(parseFeedbackSearch({ status: 'NOPE', type: 'PRAISE' })).toEqual({ status: 'PENDING' })
  })
})

describe('处理反馈弹窗校验', () => {
  test('回复用户必须写回复；结单不要求回复；内部备注恒必填', () => {
    expect(validateFeedbackHandle({ result: null, reply: '', note: '备注' })).toContain('请先选择')
    expect(validateFeedbackHandle({ result: 'REPLIED', reply: '  ', note: '备注' })).toBe(
      '请填写给用户的回复',
    )
    expect(validateFeedbackHandle({ result: 'CLOSED', reply: '', note: '' })).not.toBeNull()
    expect(validateFeedbackHandle({ result: 'CLOSED', reply: '', note: '重复反馈' })).toBeNull()
    expect(
      validateFeedbackHandle({ result: 'REPLIED', reply: '已修复', note: '已修复' }),
    ).toBeNull()
  })
})
