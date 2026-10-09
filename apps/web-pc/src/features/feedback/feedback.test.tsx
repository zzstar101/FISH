import { describe, expect, test } from 'bun:test'
import type { Feedback } from '@fish/contracts/feedback/schema'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiError } from '../../lib/api-client'
import { FeedbackRow, feedbackSubmitErrorText, submitOutcome } from './feedback-page'
import { validateFeedbackForm } from './meta'

const textOf = (html: string) => html.replace(/<[^>]*>/g, '')

function feedback(overrides: Partial<Feedback> = {}): Feedback {
  return {
    id: 'fbk_01jc000000e00800000000000a',
    type: 'BUG',
    content: '发布页上传图片后一直转圈',
    contact: null,
    status: 'PENDING',
    reply: null,
    createdAt: '2026-10-01T02:00:00.000Z',
    handledAt: null,
    ...overrides,
  }
}

describe('反馈表单本地校验（#463）', () => {
  test('未选类型 / 正文过短 / 过长 / 联系方式过长都拦下；合法输入通过', () => {
    expect(validateFeedbackForm({ type: null, content: '一二三四五', contact: '' })).toBe(
      '请选择反馈类型',
    )
    expect(validateFeedbackForm({ type: 'BUG', content: '  四个字  ', contact: '' })).toContain(
      '至少 5',
    )
    expect(validateFeedbackForm({ type: 'BUG', content: '字'.repeat(501), contact: '' })).toContain(
      '500',
    )
    expect(
      validateFeedbackForm({ type: 'BUG', content: '一二三四五', contact: 'x'.repeat(101) }),
    ).toContain('联系方式')
    expect(validateFeedbackForm({ type: 'UX', content: '一二三四五', contact: '' })).toBeNull()
  })
})

describe('反馈提交失败文案', () => {
  test('频控用服务端文案；其余错误提示内容已保留', () => {
    expect(
      feedbackSubmitErrorText(
        new ApiError('FEEDBACK_RATE_LIMITED', 429, '24 小时内最多提交 10 条'),
      ),
    ).toBe('24 小时内最多提交 10 条')
    expect(feedbackSubmitErrorText(new Error('network'))).toContain('内容已保留')
  })
})

describe('「我的反馈」行', () => {
  test('处理中不显示回复；已回复显示平台回复', () => {
    expect(
      textOf(renderToStaticMarkup(createElement(FeedbackRow, { item: feedback() }))),
    ).not.toContain('平台回复')
    const replied = textOf(
      renderToStaticMarkup(
        createElement(FeedbackRow, {
          item: feedback({
            status: 'REPLIED',
            reply: '已在新版本修复',
            handledAt: '2026-10-02T02:00:00.000Z',
          }),
        }),
      ),
    )
    expect(replied).toContain('已回复')
    expect(replied).toContain('平台回复已在新版本修复')
  })
})

describe('提交结果判定（同键重放）', () => {
  const sent = { type: 'BUG' as const, content: '发布页上传图片后一直转圈' }
  test('新建或同内容重放都算已提交', () => {
    expect(submitOutcome(sent, { created: true, feedback: sent })).toBe('submitted')
    expect(submitOutcome(sent, { created: false, feedback: sent })).toBe('submitted')
  })
  test('重放回来的是改动前的内容：判为 stale-replay，不能清空草稿', () => {
    expect(
      submitOutcome(
        { ...sent, content: `${sent.content}，补充：iOS 才会` },
        { created: false, feedback: sent },
      ),
    ).toBe('stale-replay')
    expect(submitOutcome({ ...sent, type: 'UX' }, { created: false, feedback: sent })).toBe(
      'stale-replay',
    )
  })
})
