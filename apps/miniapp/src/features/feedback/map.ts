/**
 * 后端 `Feedback` → 端上 `FeedbackRecord` 的映射（提交结果弹层与「我的反馈」列表共用）。
 *
 * 需要这一层的原因与 `features/reports/map.ts` 相同：契约字段是给机器用的
 * （ISO 时间、枚举值），端上卡片要的是可读文案（`今天 12:00` / `昨天 09:30`）。
 * 时间统一走 `lib/time.ts` 的 `dayLabelOf`，与小程序其它列表同一口径。
 *
 * `contact` 刻意不进展示记录：它是本人填写的联系方式，列表与成功弹层都不需要重复展示；
 * 契约保证它只对本人与管理员可见，端上更没必要把它渲染到屏幕上。
 */
import type { Feedback } from '@fish/contracts/feedback/schema'
import { dayLabelOf } from '@/lib/time'
import type { FeedbackRecord } from './demo'

/**
 * `nowMs` 由调用方传入（而不是在这里取 `Date.now()`）：同一屏里的多条记录必须按**同一个
 * 现在**算「今天 / 昨天」，否则跨过午夜刷新时同一份列表会出现自相矛盾的时间。
 */
export function feedbackToRecord(feedback: Feedback, nowMs: number): FeedbackRecord {
  return {
    id: feedback.id,
    type: feedback.type,
    content: feedback.content,
    reply: feedback.reply,
    status: feedback.status,
    timeLabel: dayLabelOf(feedback.createdAt, nowMs),
  }
}

/**
 * 编号的短形式：完整 `fbk_` 编号 26 个字符，卡片上放不下也没必要。
 * 保留前缀 + 尾段（用户核对时看尾段就够；后端日志里贴完整编号）。
 */
export function shortFeedbackId(id: string): string {
  return id.length <= 14 ? id : `${id.slice(0, 9)}…${id.slice(-4)}`
}
