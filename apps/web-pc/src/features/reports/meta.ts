import {
  LISTING_REPORT_REASONS as CONTRACT_LISTING_REASONS,
  USER_REPORT_REASONS as CONTRACT_USER_REASONS,
  type ListingReportReason,
  type ReportReason,
  type ReportStatus,
  type ReportTargetType,
  type UserReportReason,
} from '@fish/contracts/reports/schema'

/**
 * 举报域的文案与展示元数据（举报弹窗 / 我的举报列表共用）。
 *
 * **枚举顺序与取值只来自 `@fish/contracts/reports/schema`**：这里只补 label / hint，
 * 并用 `Record<契约联合, …>` 兜住完整性 —— 契约加了枚举值而这里没补文案，
 * `tsc` 当场报错，而不是线上渲染出一个空胶囊。
 *
 * 小程序侧有一份同口径的文案（`apps/miniapp/src/features/reports/meta.ts`）。
 * 按 roadmap §4.5「页面实现只放 `apps/web-pc`，共享契约从 `@fish/contracts` 读取」，
 * PC 自带一份而不是跨端 import 小程序的模块；两端文案若要强一致，应另起 Issue
 * 把 **copy**（不是枚举）抽到共享包，本 Issue 不做。
 */

export type ReportReasonOption = {
  /** 后端原因枚举值，提交时原样回传。 */
  key: string
  /** 选项文案。 */
  label: string
  /** 选中后的补充说明 placeholder：点名要「可核查的信息」。 */
  hint: string
}

const LISTING_REASON_COPY: Record<ListingReportReason, { label: string; hint: string }> = {
  MISLEADING: {
    label: '描述与实物不符',
    hint: '请说明商品页描述与实际不符的地方（成色 / 型号 / 功能…），便于平台核对',
  },
  PROHIBITED: {
    label: '违禁品或禁售物',
    hint: '请说明涉嫌违规的品类或内容，以及你看到它的位置',
  },
  FRAUD: {
    label: '涉嫌欺诈',
    hint: '请提供对方的具体言行（如要求线下转账）与大致时间，便于核对会话记录',
  },
  SPAM: {
    label: '垃圾广告或引流',
    hint: '请说明引流方式（如外部链接 / 二维码 / 加微信）与出现的位置',
  },
  OTHER: { label: '其他', hint: '请描述该商品的违规情形，包含具体位置与内容' },
}

const USER_REASON_COPY: Record<UserReportReason, { label: string; hint: string }> = {
  HARASSMENT: { label: '骚扰', hint: '请说明对方骚扰的方式与大致时间，便于核对会话记录' },
  FRAUD: {
    label: '涉嫌欺诈',
    hint: '请提供对方的具体言行（如要求线下转账）与大致时间，便于核对会话记录',
  },
  IMPERSONATION: {
    label: '冒充他人',
    hint: '请说明对方冒充的身份（如同学 / 官方人员）以及你判断的依据',
  },
  ABUSE: {
    label: '辱骂或恶意行为',
    hint: '请描述对方的言行与大致时间，便于核对会话记录',
  },
  OTHER: { label: '其他', hint: '请描述该用户的违规情形，包含具体言行与时间' },
}

/** 商品类原因；顺序即契约 `LISTING_REPORT_REASONS` 的顺序。 */
export const LISTING_REASON_OPTIONS: ReportReasonOption[] = CONTRACT_LISTING_REASONS.map((key) => ({
  key,
  ...LISTING_REASON_COPY[key],
}))

/** 用户类原因；与商品类是**两套枚举**，提交时服务端会再校验一次 targetType 与原因是否匹配。 */
export const USER_REASON_OPTIONS: ReportReasonOption[] = CONTRACT_USER_REASONS.map((key) => ({
  key,
  ...USER_REASON_COPY[key],
}))

/** 未选原因时说明框的 placeholder。 */
export const REPORT_DESC_PLACEHOLDER = '选填：补充时间、对方言行等细节，帮助平台更快核查'

/** 契约 `ReportCreateInputSchema.detailText` 的上限（`z.string().trim().max(200)`）。 */
export const REPORT_DETAIL_MAX_LENGTH = 200

export function reasonsOf(target: ReportTargetType): ReportReasonOption[] {
  return target === 'LISTING' ? LISTING_REASON_OPTIONS : USER_REASON_OPTIONS
}

export function reasonLabel(target: ReportTargetType, key: string): string {
  return reasonsOf(target).find((option) => option.key === key)?.label ?? key
}

/**
 * 全量原因文案（管理端「原因」筛选用）：筛选不区分 targetType，所以要把两个子枚举的
 * label 合起来 —— 值仍只来自上面两份 copy（`FRAUD`/`OTHER` 两边同名，取任一即可），
 * `Record<ReportReason, …>` 保证契约新增原因时这里漏补就编译失败。
 */
export const REPORT_REASON_LABEL: Record<ReportReason, string> = {
  MISLEADING: LISTING_REASON_COPY.MISLEADING.label,
  PROHIBITED: LISTING_REASON_COPY.PROHIBITED.label,
  FRAUD: LISTING_REASON_COPY.FRAUD.label,
  SPAM: LISTING_REASON_COPY.SPAM.label,
  HARASSMENT: USER_REASON_COPY.HARASSMENT.label,
  IMPERSONATION: USER_REASON_COPY.IMPERSONATION.label,
  ABUSE: USER_REASON_COPY.ABUSE.label,
  OTHER: LISTING_REASON_COPY.OTHER.label,
}

/**
 * 状态三态的展示元数据。`variant` 直接给 `@fish/ui/badge` 的柔和色变体：
 * 审核中=warn、已受理=success、已驳回=danger（与小程序端同一套语义色）。
 */
export const REPORT_STATUS_META: Record<
  ReportStatus,
  { label: string; variant: 'warn' | 'success' | 'danger' }
> = {
  PENDING: { label: '审核中', variant: 'warn' },
  HANDLED: { label: '已受理', variant: 'success' },
  REJECTED: { label: '已驳回', variant: 'danger' },
}

/**
 * 「我的举报」空态。列表确实接的是 `GET /reports/mine`，所以空列表的含义就是
 * 「你还没举报过」，不是「功能没有后端」。
 */
export const REPORT_EMPTY_COPY = {
  title: '还没有提交过举报',
  text: '在商品详情或会话页点击「举报」，提交后处理进度会出现在这里。',
}
