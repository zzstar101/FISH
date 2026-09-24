/**
 * 举报原因的枚举子集、文案与「选原因」面板（#73 治理半场）。
 *
 * **原因子集按对象类型收敛**（grill Q2）：DB 用一张 `report_reason` 枚举同时服务两类
 * 对象，契约层在 `ReportCreateInputSchema` 的 `superRefine` 里拒掉跨子集的组合
 * （给 422 + 明确文案）。客户端因此**不能**把 8 个原因平铺给用户 —— 选了一个必然被拒的
 * 组合，是在让用户白填一次表单。
 *
 * 子集本身从契约 import（`LISTING_REPORT_REASONS` / `USER_REPORT_REASONS`），
 * 不在这里复制一份：那两份一旦漂移，前端会给出一堆服务端必拒的选项。
 */

import {
  LISTING_REPORT_REASONS,
  type ReportReason,
  type ReportTargetType,
  USER_REPORT_REASONS,
} from '@fish/contracts/reports/schema'
import Taro from '@tarojs/taro'
import { isApiError } from '@/lib/request'

/**
 * 原因的展示文案。**键覆盖整个 `ReportReason`**（含两类都不用的值不会被引用到，
 * 但漏一个键 TS 就会报 —— 枚举扩容时这里是编译期提醒）。
 */
export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  MISLEADING: '信息不实，与描述不符',
  PROHIBITED: '违规商品',
  FRAUD: '涉嫌诈骗',
  SPAM: '垃圾信息 / 广告',
  HARASSMENT: '骚扰、辱骂',
  IMPERSONATION: '冒充他人',
  ABUSE: '滥用平台功能',
  OTHER: '其他问题',
}

export type ReportReasonOption = { reason: ReportReason; label: string }

/** 某类对象可选的原因（顺序即面板里的顺序）。 */
export function reportReasonOptions(targetType: ReportTargetType): ReportReasonOption[] {
  const allowed = targetType === 'LISTING' ? LISTING_REPORT_REASONS : USER_REPORT_REASONS
  return allowed.map((reason) => ({ reason, label: REPORT_REASON_LABELS[reason] }))
}

/**
 * 弹出原因面板，返回用户选中的原因；**取消或面板本身就唤不起来时返回 `null`**
 * （调用方无需区分这两种情况：都不该打开补充说明浮层）。
 *
 * 手法同 `pages/settings/index.tsx` 的「谁可以给我留言」：`showActionSheet` 的原生
 * 列表 + `res.tapIndex` 回映。仓库没有 radio 组件，也不该为 5 个选项造一个。
 */
export function pickReportReason(targetType: ReportTargetType): Promise<ReportReason | null> {
  const options = reportReasonOptions(targetType)
  return Taro.showActionSheet({ itemList: options.map((item) => item.label) })
    .then((res) => options[res.tapIndex]?.reason ?? null)
    .catch(() => null)
}

/**
 * 把举报失败翻译成用户能接着做点什么的文案。
 *
 * 错误码是契约冻结的（`ReportErrorCodeSchema`）：只依赖 `code` 分支，不解析 message 文案。
 * 401 未登录给明确引导而不是「失败」—— 举报必须带 `reporterId`，匿名提交服务端直接拒。
 */
export function reportFailureMessage(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === 'REPORT_SELF_TARGET') return '不能举报自己'
    if (error.code === 'REPORT_TARGET_NOT_FOUND') return '举报对象不存在或已删除'
    if (error.status === 401) return '请先登录后再举报'
    if (error.status === 422) return error.message || '举报内容没有通过校验'
  }
  return '举报提交失败，请重试'
}
