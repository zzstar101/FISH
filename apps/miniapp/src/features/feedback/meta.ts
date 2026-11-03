/**
 * 意见反馈的纯数据与文案（提交页 `pkg-legal/pages/feedback` 与列表页
 * `pkg-legal/pages/my-feedback` 共用）。
 *
 * 枚举的**唯一来源**是 `@fish/contracts/feedback/schema`（#463：后端与 PC 端已按它落地）。
 * 这里只按契约顺序补 label / hint，并用 `Record<契约联合, …>` 兜住完整性 ——
 * 契约加了枚举值而这里没补文案，`tsc` 当场报错，而不是线上渲染出一个空胶囊。
 *
 * 本模块不 import 任何 Taro / fixture 模块，`tests/feedback.test.ts` 直接加载它。
 */
import {
  FEEDBACK_DAILY_LIMIT,
  type Feedback,
  type FeedbackStatus,
  type FeedbackType,
} from '@fish/contracts/feedback/schema'

/** 反馈类型的 label 与描述框引导文案（照 1 版稿；类型清单最终定稿归 #399） */
export const FEEDBACK_TYPE_COPY: Record<FeedbackType, { label: string; hint: string }> = {
  BUG: {
    label: '功能异常',
    hint: '请描述出现问题的页面、你的操作步骤，以及你期望的结果，便于我们复现',
  },
  UX: {
    label: '体验建议',
    hint: '请描述你觉得不顺手的地方，以及你希望改成什么样',
  },
  DISPUTE: {
    label: '交易纠纷',
    hint: '请提供商品名称、对方昵称与大致交易时间，便于我们核对交易记录',
  },
  REPORT: {
    label: '违规举报',
    hint: '请提供违规内容的位置（商品 / 会话 / 用户昵称）与具体情形，我们会尽快核查',
  },
  ACCOUNT: {
    label: '账号与认证',
    hint: '请描述你遇到的问题，例如收不到验证码、认证状态异常、无法登录等',
  },
  OTHER: {
    label: '其他',
    hint: '请描述你遇到的问题或建议，包含出现的位置、操作步骤与期望结果，便于我们定位',
  },
}

/**
 * 状态的展示元数据。`PENDING` 处理中、`REPLIED` 已回复（终态，带管理员回复）、
 * `CLOSED` 已处理（终态，不回复直接结单）—— 状态机见契约 `FeedbackStatusSchema`。
 * tone 决定胶囊用哪套语义色（warn=处理中、ok=已回复、neutral=已处理）。
 */
export const FEEDBACK_STATUS_META: Record<
  FeedbackStatus,
  { label: string; tone: 'pending' | 'replied' | 'closed' }
> = {
  PENDING: { label: '处理中', tone: 'pending' },
  REPLIED: { label: '已回复', tone: 'replied' },
  CLOSED: { label: '已处理', tone: 'closed' },
}

/**
 * 提交失败的用户可见文案（`POST /feedback` 抛出的 `ApiError.code`）。
 *
 * **只按码给固定文案**：服务端 `message` 是给排查用的，直接透给用户既可能泄露内部信息、
 * 也不保证是中文。`null` 覆盖非 `ApiError`（网络层、契约解析失败）——统一说「稍后重试」，
 * 细节留在页面的日志与错误对象里。
 */
export function submitFailureText(code: string | null): string {
  if (code === 'FEEDBACK_RATE_LIMITED')
    return `24 小时内最多提交 ${FEEDBACK_DAILY_LIMIT} 条反馈，请稍后再试`
  if (code === 'VALIDATION_FAILED') return '内容不符合要求，请检查后重试'
  if (code === 'UNAUTHENTICATED') return '登录已过期，请重新登录后再提交'
  return '提交失败，内容已保留，请稍后重试'
}

/**
 * 同一 `clientRequestId` 的重放（`created: false`）只会交回**首次**提交的那条：
 * 如果用户在失败后改过草稿再重试，服务端那条与本次发出的内容不同。此时不能清空草稿
 * 冒充「已提交」——改动没有送达。返回 `stale-replay` 让页面保留草稿并换新键。
 *
 * `created: true` 的判定与 PC 端（`apps/web-pc/src/features/feedback/feedback-page.tsx`
 * 的 `submitOutcome`）一致；重放时额外比较 `contact`（空值统一成 `null`）——只改了联系方式
 * 的「重试」交回的是旧联系方式，这次修改同样没有送达，不能当成功把草稿清掉。
 */
export function submitOutcome(
  sent: { type: FeedbackType; content: string; contact: string | null },
  response: { created: boolean; feedback: Pick<Feedback, 'type' | 'content' | 'contact'> },
): 'submitted' | 'stale-replay' {
  if (response.created) return 'submitted'
  const delivered =
    response.feedback.type === sent.type &&
    response.feedback.content === sent.content &&
    response.feedback.contact === sent.contact
  return delivered ? 'submitted' : 'stale-replay'
}

/** 提交结果弹层要展示的内容：`submitted` = 本次真的送达；`stale-replay` = 只交回了旧的那条 */
export type FeedbackSubmitOutcome = 'submitted' | 'stale-replay'

/** 弹层正文（正文只说成立的话；演示构建模拟成功时由页面追加演示说明带） */
export function submitResultCopy(outcome: FeedbackSubmitOutcome): { title: string; text: string } {
  if (outcome === 'submitted') {
    return {
      title: '反馈已提交',
      text: '我们已收到你的反馈，会逐条阅读；处理结果与回复会显示在「我的反馈」里。',
    }
  }
  return {
    title: '这条反馈此前已提交',
    text: '你上一次的提交已经送达，之后的修改没有提交。草稿已保留，确认后可以再提交一次。',
  }
}

/** 「我的反馈」空态文案 */
export const FEEDBACK_EMPTY_COPY = {
  title: '还没有提交过反馈',
  text: '在「意见反馈」页描述你遇到的问题或建议；提交后，处理进度与管理员回复会出现在这里。',
  actionLabel: '去反馈',
} as const
