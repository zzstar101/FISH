import type {
  AdminAuditAction,
  AdminCapability,
  AdminModerationRecord,
  UserRole,
} from '@fish/contracts/admin/schema'
import type { AuthStatus } from '@fish/contracts/auth/user'
import type {
  AdminDisputeDetail,
  DisputeResolution,
  DisputeStatus,
  DisputeType,
} from '@fish/contracts/disputes/schema'
import type { ListingModerationStatus, ListingStatus } from '@fish/contracts/listings/schema'
import type { ModerationDecision } from '@fish/contracts/moderation/schema'
import type { TransactionStatus } from '@fish/contracts/transactions/schema'

/**
 * Admin 域的展示元数据（#467）。与 `lib/labels.ts` 同一条纪律：
 * **枚举取值只来自契约**，这里只补 label / 色变体，用 `Record<契约联合, …>` 兜住完整性 ——
 * 契约加了枚举值而这里没补，`tsc` 当场报错，不会线上渲染 `undefined`。
 */

export type BadgeVariant = 'brand' | 'secondary' | 'warn' | 'success' | 'danger' | 'default'

/** 契约只导出 Schema 不导出该类型（`AdminModerationProviderSchema`）：从 DTO 派生。 */
type AdminModerationProvider = NonNullable<AdminModerationRecord['provider']>

export const LISTING_STATUS_META: Record<ListingStatus, { label: string; variant: BadgeVariant }> =
  {
    ACTIVE: { label: '在售', variant: 'success' },
    OFFLINE: { label: '已下架', variant: 'secondary' },
    RESERVED: { label: '已预定', variant: 'warn' },
    SOLD: { label: '已售出', variant: 'brand' },
  }

/** 审核引擎视角的状态（与 `status` 分开：治理下架两者都变，引擎屏蔽只变这个）。 */
export const MODERATION_STATUS_META: Record<
  ListingModerationStatus,
  { label: string; variant: BadgeVariant }
> = {
  APPROVED: { label: '审核通过', variant: 'success' },
  REVIEW: { label: '待人工审核', variant: 'warn' },
  BLOCKED: { label: '已屏蔽', variant: 'danger' },
}

export const MODERATION_DECISION_META: Record<
  ModerationDecision,
  { label: string; variant: BadgeVariant }
> = {
  ALLOW: { label: '放行', variant: 'success' },
  BLOCK: { label: '拦截', variant: 'danger' },
  REVIEW: { label: '转人工', variant: 'warn' },
}

export const TRANSACTION_STATUS_META: Record<
  TransactionStatus,
  { label: string; variant: BadgeVariant }
> = {
  PENDING_MEETUP: { label: '待面交', variant: 'warn' },
  COMPLETED: { label: '已完成', variant: 'success' },
  CANCELLED: { label: '已取消', variant: 'secondary' },
}

export const AUTH_STATUS_META: Record<AuthStatus, { label: string; variant: BadgeVariant }> = {
  UNVERIFIED: { label: '未认证', variant: 'secondary' },
  VERIFIED: { label: '已认证', variant: 'success' },
}

export const ROLE_META: Record<UserRole, { label: string; variant: BadgeVariant }> = {
  USER: { label: '用户', variant: 'secondary' },
  ADMIN: { label: '管理员', variant: 'brand' },
}

/** 审计动作枚举 → 中文。治理五动作各占一行，便于审计页按动作筛选时对得上。 */
export const AUDIT_ACTION_META: Record<AdminAuditAction, string> = {
  ADMIN_PROMOTED: '提升管理员',
  MODERATION_DECISION: '人工审核决定',
  REPORT_DECISION: '举报处理',
  DISPUTE_DECISION: '争议处理',
  LISTING_DELISTED: '下架商品',
  LISTING_RESTORED: '恢复商品',
  USER_RESTRICTED: '限制发布',
  USER_RESTRICTION_LIFTED: '解除限制',
  USER_BANNED: '封禁用户',
  USER_UNBANNED: '解封用户',
}

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_META[action as AdminAuditAction] ?? action
}

export const AUDIT_TARGET_TYPE_LABEL: Record<string, string> = {
  USER: '用户',
  LISTING: '商品',
  MODERATION_RECORD: '审核记录',
  REPORT: '举报',
  DISPUTE: '争议',
  USER_RESTRICTION: '限制记录',
}

/**
 * 审核记录上游来源（#228 §6）。含义随 provider 变化（契约注释），端上只负责标注来源：
 * LOCAL=本地词表、TENCENT_*=腾讯云、MANUAL=人工改判、null=#228 之前的历史行。
 */
export const MODERATION_PROVIDER_META: Record<
  AdminModerationProvider,
  { label: string; variant: BadgeVariant }
> = {
  LOCAL: { label: '本地词表', variant: 'secondary' },
  TENCENT_TMS: { label: '腾讯文本', variant: 'brand' },
  TENCENT_IMS: { label: '腾讯图片', variant: 'brand' },
  MANUAL: { label: '人工', variant: 'warn' },
}

export const ADMIN_CAPABILITY_LABEL: Record<AdminCapability, string> = {
  USERS_READ: '用户查询',
  LISTINGS_READ: '商品查询',
  OVERVIEW_READ: '平台概览',
  AUDIT_LOGS_READ: '审计日志',
  MODERATION_READ: '审核读取',
  MODERATION_WRITE: '人工审核',
  TRANSACTIONS_READ: '交易查询',
}

// ---------------------------------------------------------------------------
// 格式化
// ---------------------------------------------------------------------------

/** 管理表格用完整时间（相对时间在后台排查时不够精确）。 */
export function formatAdminDateTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * 比率 → 百分比文案。契约明确「分母为 0 时是 null 而不是 0」，渲染成 `—`
 * 而不是 0%（0% 会被读成“转化极差”，null 是“这个窗口里根本没有量”）。
 */
export function formatRate(rate: number | null): string {
  if (rate === null) return '—'
  return `${(rate * 100).toFixed(1)}%`
}

/** 延迟分位：count=0 时全 null → `—`。 */
export function formatLatency(ms: number | null): string {
  if (ms === null) return '—'
  return `${Math.round(ms)}ms`
}

// ---------------------------------------------------------------------------
// 写操作的纯校验（弹窗提交前先跑一遍，与服务端 422 口径一致）
// ---------------------------------------------------------------------------

/**
 * 原因必填校验：trim 后 1–500 字（`GovernanceReasonSchema` / `AdminReportHandleInputSchema`
 * / `ModerationDecisionInputSchema` 三处同口径）。返回 null 表示通过，否则给提示文案。
 */
export function validateReason(input: string): string | null {
  const trimmed = input.trim()
  if (trimmed.length === 0) return '请填写原因（必填）'
  if (trimmed.length > 500) return '原因不能超过 500 字'
  return null
}

/** 人工审核决定的幂等键：同一次弹窗实例内复用（重试不换），换弹窗实例由 key 重挂换新。 */
export function createIdempotencyKey(): string {
  return crypto.randomUUID()
}

// ---------------------------------------------------------------------------
// 交易争议（#465）
// ---------------------------------------------------------------------------

/** 争议状态机：`PENDING` 待处理，`RESOLVED` 管理员已给结论，`WITHDRAWN` 发起人已撤回。 */
export const DISPUTE_STATUS_META: Record<DisputeStatus, { label: string; variant: BadgeVariant }> =
  {
    PENDING: { label: '待处理', variant: 'warn' },
    RESOLVED: { label: '已处理', variant: 'success' },
    WITHDRAWN: { label: '已撤回', variant: 'secondary' },
  }

/**
 * 争议类型。刻意**不含**骚扰/威胁——那属于举报域，且争议结论不触发治理动作。
 *
 * 文案是管理端自己的口径：`apps/miniapp` 目前**没有**争议表单/页面
 * （`git grep ITEM_MISMATCH -- apps/miniapp` 零命中），所以不存在可对齐的用户侧文案，
 * 也就不声明「与用户侧保持一致」（#465 审查发现：原注释是一句无法验证的声明）。
 */
export const DISPUTE_TYPE_META: Record<DisputeType, { label: string }> = {
  ITEM_MISMATCH: { label: '商品与描述不符' },
  NOT_COMPLETED: { label: '交易未完成' },
  PAYMENT_ISSUE: { label: '支付问题' },
  OTHER: { label: '其他' },
}

/** 处理结论：只描述「本次反馈是否成立」，不等同于处罚。 */
export const DISPUTE_RESOLUTION_META: Record<
  DisputeResolution,
  { label: string; variant: BadgeVariant }
> = {
  UPHELD: { label: '反馈成立', variant: 'success' },
  DISMISSED: { label: '反馈不成立', variant: 'secondary' },
  INCONCLUSIVE: { label: '无法认定', variant: 'warn' },
}

/** 契约只给内联枚举（`DisputeEvidenceMessageSchema` 的 `type`）不导出具名类型：从 DTO 派生。 */
type DisputeEvidenceType = AdminDisputeDetail['evidence'][number]['message']['type']

/**
 * 证据消息类型 → 界面文案。键取自契约派生联合（`Record<契约联合, …>`）：
 * 契约新增类型而这里没补，`tsc` 当场报错；不像 `Record<string, string>` 那样
 * 把裸枚举值（`MEDIA`）静默显示给处理人（#465 审查发现 Primitive Obsession）。
 */
export const EVIDENCE_TYPE_LABEL: Record<DisputeEvidenceType, string> = {
  // 不是「商品卡片」：服务端存的是消息正文，而 LISTING 消息的正文就是商品公开 id
  //（`apps/api/src/modules/messages/service.ts`），所以这里只能显示 `lst_…` 引用。
  LISTING: '商品引用',
  MEDIA: '图片/语音',
  SYSTEM: '系统消息',
  TEXT: '文字',
}

/** 未知取值只可能来自契约漂移：照实显示原文，不猜一个像样的中文（少说胜于误导）。 */
export function evidenceTypeLabel(type: DisputeEvidenceType): string {
  return EVIDENCE_TYPE_LABEL[type] ?? type
}

// ---------------------------------------------------------------------------
// Record 索引在 noUncheckedIndexedAccess 下是 V | undefined：统一经函数回退，
// 调用方不写 `?? 兜底`（契约枚举全覆盖的 Record 理论上不会 miss，回退只兜类型系统）。
// ---------------------------------------------------------------------------

/**
 * 未知枚举值的回退（#465 审查发现）：契约是 `z.enum`，未知值只可能来自契约漂移
 * （服务端比前端新）。若回退到某个既有枚举值，`BOGUS` 会被渲染成「待处理」，
 * 处理人会当成真实状态照常操作；统一显示「未知」并标灰，宁可少说也不误导。
 */
const UNKNOWN_META: { label: string; variant: BadgeVariant } = {
  label: '未知',
  variant: 'secondary',
}

export function listingStatusMeta(status: ListingStatus) {
  return LISTING_STATUS_META[status] ?? LISTING_STATUS_META.OFFLINE
}

export function moderationStatusMeta(status: ListingModerationStatus) {
  return MODERATION_STATUS_META[status] ?? MODERATION_STATUS_META.REVIEW
}

export function moderationDecisionMeta(decision: ModerationDecision) {
  return MODERATION_DECISION_META[decision] ?? MODERATION_DECISION_META.REVIEW
}

export function transactionStatusMeta(status: TransactionStatus) {
  return TRANSACTION_STATUS_META[status] ?? TRANSACTION_STATUS_META.CANCELLED
}

export function authStatusMeta(status: AuthStatus) {
  return AUTH_STATUS_META[status] ?? AUTH_STATUS_META.UNVERIFIED
}

export function roleMeta(role: UserRole) {
  return ROLE_META[role] ?? ROLE_META.USER
}

export function moderationProviderMeta(provider: AdminModerationProvider) {
  return MODERATION_PROVIDER_META[provider] ?? MODERATION_PROVIDER_META.LOCAL
}

export function disputeStatusMeta(status: DisputeStatus) {
  return DISPUTE_STATUS_META[status] ?? UNKNOWN_META
}

export function disputeResolutionMeta(resolution: DisputeResolution) {
  return DISPUTE_RESOLUTION_META[resolution] ?? UNKNOWN_META
}

export function disputeTypeLabel(type: DisputeType): string {
  return (DISPUTE_TYPE_META[type] ?? UNKNOWN_META).label
}
