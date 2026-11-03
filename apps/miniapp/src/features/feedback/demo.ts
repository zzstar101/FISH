/**
 * 「我的反馈」的演示数据（`pkg-legal/pages/my-feedback` 用）。
 *
 * ## 演示口径（与 `features/reports/demo.ts` 同一体系）
 *
 * 后端 `GET /feedback/mine` 与 `POST /feedback` **已经接线**（#463）：真实构建先发请求，
 * 只有请求失败且构建开关允许时才回退到这里（判据见 `./load` 的 `DEMO_FEEDBACK_ENABLED`），
 * 页面据 `demo` 标志渲染「演示数据」说明带。下面 4 条只在 `TARO_APP_MOCK=1` 的演示构建里出现。
 *
 * ## 数据照 1 版稿
 *
 * 三种状态（处理中 / 已回复 / 已处理）都出现，其中两条带管理员回复 —— 列表要能看出
 * 「回复长什么样」与「已处理但没回复」的区别。编号与时间是演示占位，只为撑样式。
 *
 * ## 演示提交的「落库」只落在进程内存
 *
 * 演示兜底路径下提交反馈不会真的保存，但为了让「提交 → 我的反馈」动线在演示里能走通，
 * `rememberDemoFeedback()` 把这条记录放进本次进程的列表头（重启小程序就消失，
 * 不落 storage、更不落服务端）。
 *
 * 本模块不 import 任何 Taro / fixture 模块，`tests/feedback.test.ts` 直接加载它。
 */
import type { FeedbackStatus, FeedbackType } from '@fish/contracts/feedback/schema'

/** 列表与提交结果共用的一条展示记录（等价于 contract `Feedback` + 时间标签） */
export type FeedbackRecord = {
  /** 反馈编号（`fbk_` 前缀；真实记录来自后端返回的 `feedback.id`） */
  id: string
  type: FeedbackType
  content: string
  /** 管理员公开回复；`null` = 尚未回复 */
  reply: string | null
  status: FeedbackStatus
  /** 列表里的时间标签，与举报记录同一套 `dayLabelOf` 口径 */
  timeLabel: string
}

export const DEMO_FEEDBACK: FeedbackRecord[] = [
  {
    id: 'fbk_01J9A8Z3Q4W5E6R7T8Y9U0I1O2',
    type: 'BUG',
    content: '首页下拉刷新之后偶发白屏，要杀掉小程序重进才恢复，大概两三次能遇到一次。',
    reply: null,
    status: 'PENDING',
    timeLabel: '09-25 21:07',
  },
  {
    id: 'fbk_01J9A7Y2P3O4I5U6Y7T8R9E0W1',
    type: 'UX',
    content: '搜索页的筛选条件每次返回都会清空，如果只是点进商品看一眼再返回，重新勾选很麻烦。',
    reply: '感谢建议。搜索页会记住你上次的筛选条件，已排进下一版。',
    status: 'REPLIED',
    timeLabel: '09-21 14:32',
  },
  {
    id: 'fbk_01J9A6X1N2M3B4V5C6X7Z8L9K0',
    type: 'ACCOUNT',
    content: '教育邮箱认证一直收不到验证码，垃圾邮件箱也翻了，换了两个邮箱都不行。',
    reply: '已为你重新触发认证邮件；若 24 小时内仍未收到，请在反馈里补充邮箱域名。',
    status: 'REPLIED',
    timeLabel: '09-18 09:14',
  },
  {
    id: 'fbk_01J9A5W0M1N2B3V4C5X6Z7L8K9',
    type: 'OTHER',
    content: '希望商品详情页能显示卖家大概的回复速度，方便判断要不要等。',
    reply: null,
    status: 'CLOSED',
    timeLabel: '09-11 18:40',
  },
]

/**
 * 演示提交产生的记录（进程内存）。固定 id：反复提交时列表里只保留最后一次，
 * 而不是堆出一串同名「刚刚」的卡片。
 */
const submittedFeedback: FeedbackRecord[] = []
export const DEMO_SUBMITTED_FEEDBACK_ID = 'fbk_01J9DEMOFBK1'

export function rememberDemoFeedback(record: FeedbackRecord): void {
  const index = submittedFeedback.findIndex((item) => item.id === record.id)
  if (index >= 0) submittedFeedback.splice(index, 1)
  submittedFeedback.unshift(record)
}

const DEMO_LATENCY = 120

/** 演示提交的记录排最前（最新在前），其余按稿的顺序 */
export function loadDemoFeedback(): Promise<FeedbackRecord[]> {
  return new Promise((resolve) => {
    setTimeout(() => resolve([...submittedFeedback, ...DEMO_FEEDBACK]), DEMO_LATENCY)
  })
}
