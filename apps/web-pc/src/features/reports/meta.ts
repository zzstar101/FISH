import {
  LISTING_REPORT_REASONS as CONTRACT_LISTING_REASONS,
  MESSAGE_REPORT_REASONS as CONTRACT_MESSAGE_REASONS,
  UGC_REPORT_REASONS as CONTRACT_UGC_REASONS,
  USER_REPORT_REASONS as CONTRACT_USER_REASONS,
  type CommentReportReason,
  type ListingReportReason,
  type MessageReportReason,
  type ReportReason,
  type ReportStatus,
  type ReportTargetType,
  type ReviewReportReason,
  type UserReportReason,
  type WishReportReason,
} from '@fish/contracts/reports/schema'

/**
 * 举报域的文案与展示元数据（举报弹窗 / 我的举报列表共用）。
 *
 * **枚举顺序与取值只来自 `@fish/contracts/reports/schema`**：这里只补 label / hint，
 * 并用 `Record<契约联合, …>` 兜住完整性 —— 契约加了枚举值而这里没补文案，
 * `tsc` 当场报错，而不是线上渲染出一个空胶囊。
 *
 * 小程序侧有一份同口径的文案（`apps/miniapp/src/features/reports/meta.ts`）。
 * 按「页面实现只放 `apps/web-pc`，共享契约从 `@fish/contracts` 读取」，
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

const MESSAGE_REASON_COPY: Record<MessageReportReason, { label: string; hint: string }> = {
  SPAM: {
    label: '垃圾广告或引流',
    hint: '请说明对方在私聊里发的内容（如二维码 / 加微信 / 外链）与大致时间',
  },
  FRAUD: {
    label: '涉嫌欺诈',
    hint: '请提供对方要求转账 / 付款的具体说法与大致时间，便于核对该条消息',
  },
  HARASSMENT: {
    label: '骚扰',
    hint: '请说明对方骚扰的方式与大致时间，便于核对会话记录',
  },
  PROHIBITED: {
    label: '违禁或违法内容',
    hint: '请说明这条消息涉及的违禁内容，服务端会保留该条消息的取证快照',
  },
  OTHER: { label: '其他', hint: '请描述这条消息的违规情形，便于人工复核' },
}

const MESSAGE_REASON_OPTIONS: ReportReasonOption[] = CONTRACT_MESSAGE_REASONS.map((key) => ({
  key,
  ...MESSAGE_REASON_COPY[key],
}))

/**
 * 留言 / 评价 / 愿望三类 UGC 共用契约的 `UGC_REPORT_REASONS`（#694 M7），
 * 每类只换 hint 的口径；顺序即契约顺序。
 */
const COMMENT_REASON_COPY: Record<CommentReportReason, { label: string; hint: string }> = {
  SPAM: {
    label: '垃圾广告或引流',
    hint: '请说明这条留言里的引流方式（外链 / 二维码 / 联系方式）与大致时间',
  },
  HARASSMENT: {
    label: '骚扰',
    hint: '请说明对方在这条留言里的骚扰言辞与大致时间',
  },
  PROHIBITED: {
    label: '违禁或违法内容',
    hint: '请说明这条留言涉及的违禁内容，服务端会保留留言取证快照',
  },
  ABUSE: {
    label: '辱骂或恶意攻击',
    hint: '请指出留言中的辱骂 / 人身攻击内容，服务端会保留留言取证快照',
  },
  OTHER: { label: '其他', hint: '请描述这条留言的违规情形，便于人工复核' },
}

const REVIEW_REASON_COPY: Record<ReviewReportReason, { label: string; hint: string }> = {
  SPAM: {
    label: '垃圾广告或引流',
    hint: '请说明这条评价里的引流内容（外链 / 二维码 / 联系方式）与大致时间',
  },
  HARASSMENT: {
    label: '骚扰',
    hint: '请说明评价正文或配图中的骚扰内容与大致时间',
  },
  PROHIBITED: {
    label: '违禁或违法内容',
    hint: '请说明评价正文或配图中的违禁内容，服务端会保留评价取证快照',
  },
  ABUSE: {
    label: '辱骂或恶意攻击',
    hint: '请指出评价正文 / 配图中的辱骂或人身攻击内容，服务端会保留快照',
  },
  OTHER: { label: '其他', hint: '请描述这条评价的违规情形，便于人工复核' },
}

const WISH_REASON_COPY: Record<WishReportReason, { label: string; hint: string }> = {
  SPAM: {
    label: '垃圾广告或引流',
    hint: '请说明这条愿望里的引流方式（外链 / 二维码 / 联系方式）',
  },
  HARASSMENT: {
    label: '骚扰',
    hint: '请说明愿望描述中的骚扰言辞与大致时间',
  },
  PROHIBITED: {
    label: '违禁或违法内容',
    hint: '请说明愿望描述中的违禁内容，服务端会保留愿望取证快照',
  },
  ABUSE: { label: '辱骂或恶意攻击', hint: '请指出愿望描述中的辱骂或人身攻击内容' },
  OTHER: { label: '其他', hint: '请描述这条愿望的违规情形，便于人工复核' },
}

const COMMENT_REASON_OPTIONS: ReportReasonOption[] = CONTRACT_UGC_REASONS.map((key) => ({
  key,
  ...COMMENT_REASON_COPY[key],
}))

const REVIEW_REASON_OPTIONS: ReportReasonOption[] = CONTRACT_UGC_REASONS.map((key) => ({
  key,
  ...REVIEW_REASON_COPY[key],
}))

const WISH_REASON_OPTIONS: ReportReasonOption[] = CONTRACT_UGC_REASONS.map((key) => ({
  key,
  ...WISH_REASON_COPY[key],
}))

const REASON_OPTIONS_BY_TARGET = {
  LISTING: LISTING_REASON_OPTIONS,
  USER: USER_REASON_OPTIONS,
  MESSAGE: MESSAGE_REASON_OPTIONS,
  COMMENT: COMMENT_REASON_OPTIONS,
  REVIEW: REVIEW_REASON_OPTIONS,
  WISH: WISH_REASON_OPTIONS,
} satisfies Record<ReportTargetType, ReportReasonOption[]>

export function reasonsOf(target: ReportTargetType): ReportReasonOption[] {
  return REASON_OPTIONS_BY_TARGET[target]
}

/** 举报目标类型的中文称呼（队列行、详情标题、弹窗共用一份）。 */
export const REPORT_TARGET_LABEL: Record<ReportTargetType, string> = {
  LISTING: '商品',
  USER: '用户',
  MESSAGE: '消息',
  COMMENT: '留言',
  REVIEW: '评价',
  WISH: '愿望',
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
