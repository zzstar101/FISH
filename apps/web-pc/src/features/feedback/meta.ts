import {
  FEEDBACK_CONTACT_MAX,
  FEEDBACK_CONTENT_MAX,
  FEEDBACK_CONTENT_MIN,
  type FeedbackStatus,
  type FeedbackType,
} from '@fish/contracts/feedback/schema'

/**
 * 意见反馈的文案与展示元数据（#463；用户侧反馈页与管理端队列共用）。
 *
 * 枚举只来自 `@fish/contracts/feedback/schema`，这里用 `Record<契约联合, …>` 补 label：
 * 契约加值而这里没补，`tsc` 当场报错。类型 label 取自小程序反馈页的初稿（清单定稿归 #399）。
 */
export const FEEDBACK_TYPE_LABEL: Record<FeedbackType, string> = {
  BUG: '功能异常',
  UX: '体验建议',
  DISPUTE: '交易纠纷',
  REPORT: '违规举报',
  ACCOUNT: '账号与认证',
  OTHER: '其他',
}

export const FEEDBACK_STATUS_META: Record<
  FeedbackStatus,
  { label: string; variant: 'warn' | 'success' | 'secondary' }
> = {
  PENDING: { label: '处理中', variant: 'warn' },
  REPLIED: { label: '已回复', variant: 'success' },
  CLOSED: { label: '已处理', variant: 'secondary' },
}

/** 提交前的本地校验（与契约同口径；服务端仍是最终裁决）。返回 null = 通过。 */
export function validateFeedbackForm(input: {
  type: FeedbackType | null
  content: string
  contact: string
}): string | null {
  if (input.type === null) return '请选择反馈类型'
  const content = input.content.trim()
  if (content.length < FEEDBACK_CONTENT_MIN) return `问题描述至少 ${FEEDBACK_CONTENT_MIN} 个字`
  if (content.length > FEEDBACK_CONTENT_MAX) return `问题描述不能超过 ${FEEDBACK_CONTENT_MAX} 字`
  if (input.contact.trim().length > FEEDBACK_CONTACT_MAX) {
    return `联系方式不能超过 ${FEEDBACK_CONTACT_MAX} 字`
  }
  return null
}
