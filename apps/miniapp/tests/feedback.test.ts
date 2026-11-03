import { describe, expect, test } from 'bun:test'
import {
  type Feedback,
  FeedbackStatusSchema,
  FeedbackTypeSchema,
} from '@fish/contracts/feedback/schema'
import {
  DEMO_FEEDBACK,
  DEMO_SUBMITTED_FEEDBACK_ID,
  loadDemoFeedback,
  rememberDemoFeedback,
} from '../src/features/feedback/demo'
import { feedbackToRecord, shortFeedbackId } from '../src/features/feedback/map'
import {
  FEEDBACK_STATUS_META,
  FEEDBACK_TYPE_COPY,
  submitFailureText,
  submitOutcome,
  submitResultCopy,
} from '../src/features/feedback/meta'
import { dayLabelOf } from '../src/lib/time'

/**
 * 意见反馈的纯逻辑：状态 / 类型文案、幂等重放的判定、失败文案、契约记录映射与演示数据。
 *
 * 页面的提交动线依赖「`created:false` 到底算不算成功」这个判断 —— 判错就会在重放时
 * 把用户后改的内容当成已提交（清空草稿），所以这里单独钉住它。
 */
describe('submitOutcome —— 同一 clientRequestId 的重放算不算提交成功', () => {
  test('created: true 一定是本次新建', () => {
    expect(
      submitOutcome(
        { type: 'BUG', content: '点不动', contact: null },
        { created: true, feedback: { type: 'OTHER', content: '完全无关', contact: null } },
      ),
    ).toBe('submitted')
  })

  test('created: false 且类型 / 正文 / 联系方式都一致 → 视为成功（重试命中了同一条）', () => {
    expect(
      submitOutcome(
        { type: 'UX', content: '筛选条件丢了', contact: '微信 abc' },
        { created: false, feedback: { type: 'UX', content: '筛选条件丢了', contact: '微信 abc' } },
      ),
    ).toBe('submitted')
    expect(
      submitOutcome(
        { type: 'OTHER', content: '其他问题', contact: null },
        { created: false, feedback: { type: 'OTHER', content: '其他问题', contact: null } },
      ),
    ).toBe('submitted')
  })

  test('created: false 但类型 / 正文不同 → 服务端交回的是更早那条，本次修改没送达', () => {
    expect(
      submitOutcome(
        { type: 'UX', content: '改过之后的正文', contact: null },
        { created: false, feedback: { type: 'UX', content: '改之前的正文', contact: null } },
      ),
    ).toBe('stale-replay')
    expect(
      submitOutcome(
        { type: 'UX', content: '同一段正文', contact: null },
        { created: false, feedback: { type: 'BUG', content: '同一段正文', contact: null } },
      ),
    ).toBe('stale-replay')
  })

  test('created: false 只改了联系方式 → 服务端交回旧值，本次修改同样没送达', () => {
    expect(
      submitOutcome(
        { type: 'UX', content: '同一段正文', contact: '微信 new' },
        { created: false, feedback: { type: 'UX', content: '同一段正文', contact: '微信 old' } },
      ),
    ).toBe('stale-replay')
    // 空联系方式在契约里是 null；用户清空后重试同样算「改过」
    expect(
      submitOutcome(
        { type: 'UX', content: '同一段正文', contact: null },
        { created: false, feedback: { type: 'UX', content: '同一段正文', contact: '微信 old' } },
      ),
    ).toBe('stale-replay')
  })
})

describe('文案表与契约枚举保持完整', () => {
  test('每个反馈类型都有 label 与 hint', () => {
    for (const type of FeedbackTypeSchema.options) {
      expect(FEEDBACK_TYPE_COPY[type].label.length).toBeGreaterThan(0)
      expect(FEEDBACK_TYPE_COPY[type].hint.length).toBeGreaterThan(0)
    }
  })

  test('每个状态都有展示文案与 tonal 分组', () => {
    for (const status of FeedbackStatusSchema.options) {
      expect(FEEDBACK_STATUS_META[status].label.length).toBeGreaterThan(0)
      expect(FEEDBACK_STATUS_META[status].tone.length).toBeGreaterThan(0)
    }
  })

  test('失败文案按错误码区分，且默认不泄露内部信息', () => {
    expect(submitFailureText('FEEDBACK_RATE_LIMITED')).toContain('10 条')
    expect(submitFailureText('VALIDATION_FAILED')).toBe('内容不符合要求，请检查后重试')
    expect(submitFailureText('UNAUTHENTICATED')).toContain('重新登录')
    expect(submitFailureText(null)).toBe('提交失败，内容已保留，请稍后重试')
    expect(submitFailureText('SOMETHING_INTERNAL')).toBe('提交失败，内容已保留，请稍后重试')
  })

  test('结果弹层两种结论的标题不同', () => {
    expect(submitResultCopy('submitted').title).toBe('反馈已提交')
    expect(submitResultCopy('stale-replay').title).toBe('这条反馈此前已提交')
  })
})

describe('feedbackToRecord —— 契约记录 → 列表卡片数据', () => {
  const now = Date.parse('2026-10-20T12:00:00.000Z')
  const feedback: Feedback = {
    id: 'fbk_01J9A8Z3Q4W5E6R7T8Y9U0I1O2',
    type: 'BUG',
    content: '正文内容',
    contact: '微信 abc',
    status: 'PENDING',
    reply: null,
    createdAt: '2026-10-20T11:58:00.000Z',
    handledAt: null,
  }

  test('字段逐一透传，时间用 dayLabelOf 口径，联系方式不落展示记录', () => {
    const record = feedbackToRecord(feedback, now)
    expect(record.id).toBe(feedback.id)
    expect(record.type).toBe(feedback.type)
    expect(record.content).toBe(feedback.content)
    expect(record.reply).toBeNull()
    expect(record.status).toBe('PENDING')
    expect(record.timeLabel).toBe(dayLabelOf(feedback.createdAt, now))
    expect(Object.keys(record)).not.toContain('contact')
  })

  test('有回复时原样带入', () => {
    const record = feedbackToRecord(
      { ...feedback, status: 'REPLIED', reply: '已修复', type: 'BUG' },
      now,
    )
    expect(record.reply).toBe('已修复')
    expect(record.status).toBe('REPLIED')
  })
})

describe('shortFeedbackId —— 卡片上的短编号', () => {
  test('长编号保留前缀与尾段，短编号原样返回', () => {
    expect(shortFeedbackId('fbk_01J9A8Z3Q4W5E6R7T8Y9U0I1O2')).toBe('fbk_01J9A…I1O2')
    expect(shortFeedbackId('fbk_123')).toBe('fbk_123')
  })
})

describe('演示数据与模拟提交', () => {
  test('三种状态都出现，且至少一条带管理员回复', () => {
    const statuses = new Set(DEMO_FEEDBACK.map((item) => item.status))
    expect(statuses).toEqual(new Set(['PENDING', 'REPLIED', 'CLOSED']))
    expect(DEMO_FEEDBACK.some((item) => item.reply !== null)).toBe(true)
  })

  test('模拟提交排在最前，重复提交只保留最后一次', async () => {
    const first = { ...DEMO_FEEDBACK[0], id: DEMO_SUBMITTED_FEEDBACK_ID, content: '第一次' }
    const second = { ...first, content: '第二次' }
    rememberDemoFeedback(first)
    rememberDemoFeedback(second)
    const items = await loadDemoFeedback()
    expect(items[0]?.id).toBe(DEMO_SUBMITTED_FEEDBACK_ID)
    expect(items[0]?.content).toBe('第二次')
    expect(items.filter((item) => item.id === DEMO_SUBMITTED_FEEDBACK_ID)).toHaveLength(1)
  })
})
