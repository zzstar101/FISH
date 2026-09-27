/**
 * 后端 `Report` → 端上 `ReportRecord` 的映射（`pages/my-reports` 与两个填写页的只读态共用）。
 *
 * ## 为什么需要这一层
 *
 * 契约 `ReportSchema` 是**用户端 DTO**，刻意只给用户可见字段：编号、目标类型与公开 ID、
 * 原因、补充说明、状态、时间。端上的 `ReportRecord`（`./demo` 定义，先于本层存在）是为
 * 演示稿的卡片排版设计的，多两个展示字段（对象标题 / 价格）——那正是契约**不返回**的东西，
 * 所以这里必须给出一个如实的兜底，而不是编一个标题。
 *
 * ## 兜底的口径
 *
 * - **对象标题**：用户端拿不到被举报对象的摘要（`ReportTargetSummary` 是**管理端**字段，
 *   带 `label` / `listingStatus` / `moderationStatus`），所以给中性称呼「被举报商品 /
 *   被举报用户」，并把 `targetId`（`lst_` / `usr_` 公开 ID）一并带上，让用户能对上号。
 *   不做「按 ID 再拉一次详情」的补全：那会为列表里每条记录各发一次请求，而列表最多 250 条；
 *   且被举报内容可能已被下架，补全本身就不可靠。
 * - **价格**：同样不在 DTO 里，恒为 `null`（卡片不渲染价格位，不显示 `¥0`）。
 * - **时间**：由 `createdAt` 派生，与小程序其它列表同一套 `dayLabelOf` 口径
 *   （`今天 12:00` / `昨天 09:30` / `9 月 14 日 20:15`）。演示数据的 `09-25 21:07` 是稿子里的
 *   静态占位，真实记录不走它。
 *
 * ## 不映射的东西
 *
 * `handledAt` 与（管理端的）`handlingReason` 都不进端上记录：状态三态已经表达了结论，
 * #252 明确要求**管理员处理原因不落端上**。
 */
import type { Report } from '@fish/contracts/reports/schema'
import { dayLabelOf } from '@/lib/time'
import type { ReportRecord } from './demo'
import type { ReportTarget } from './meta'

/** 契约不给对象摘要，用中性称呼 + 下面的公开 ID 让用户指认对象。 */
const TARGET_TITLE: Record<ReportTarget, string> = {
  LISTING: '被举报商品',
  USER: '被举报用户',
}

/**
 * `nowMs` 由调用方传入（而不是在这里取 `Date.now()`）：同一屏里的多条记录必须按**同一个
 * 现在**算「今天 / 昨天」，否则跨过午夜刷新时同一份列表会出现自相矛盾的时间 ——
 * 与 `lib/time.ts` 对 `relativeTimeOf` / `dayLabelOf` 的约定一致。
 */
export function reportToRecord(report: Report, nowMs: number): ReportRecord {
  return {
    id: report.id,
    target: report.targetType,
    objTitle: TARGET_TITLE[report.targetType],
    objPrice: null,
    objId: report.targetId,
    reason: report.reason,
    desc: report.detailText ?? '',
    timeLabel: dayLabelOf(report.createdAt, nowMs),
    status: report.status,
  }
}
