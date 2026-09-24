/**
 * Admin 后台的展示层映射（#73）：契约枚举 / 状态 → 中文文案，以及日期格式化。
 * 与普通用户页一样只做展示口径，不参与任何授权逻辑。
 */

export const LISTING_STATUS_LABEL: Record<string, string> = {
  ACTIVE: '在售',
  RESERVED: '已预留',
  SOLD: '已售出',
  OFFLINE: '已下架',
}

export const AUTH_STATUS_LABEL: Record<string, string> = {
  VERIFIED: '已认证',
  UNVERIFIED: '未认证',
}

export const USER_ROLE_LABEL: Record<string, string> = {
  USER: '用户',
  ADMIN: '管理员',
}

export const AUDIT_ACTION_LABEL: Record<string, string> = {
  ADMIN_PROMOTED: '提升管理员',
  MODERATION_DECISION: '人工审核决定',
  REPORT_DECISION: '举报处理',
  // #73 治理半场 PR3：一个端点一个 action，审计日志页要能单独筛出「谁下架了什么」。
  LISTING_DELISTED: '下架商品',
  LISTING_RESTORED: '恢复商品',
  USER_RESTRICTED: '限制发布',
  USER_RESTRICTION_LIFTED: '解除限制',
  USER_BANNED: '封禁用户',
  USER_UNBANNED: '解除封禁',
}

export const AUDIT_TARGET_LABEL: Record<string, string> = {
  USER: '用户',
  LISTING: '商品',
  MODERATION_RECORD: '审核记录',
  REPORT: '举报',
  USER_RESTRICTION: '限制记录',
}

/** 治理动作文案（按钮 / 结果提示）。与 AUDIT_ACTION_LABEL 同口径但不共用映射。 */
export const GOVERNANCE_ACTION_LABEL: Record<string, string> = {
  LISTING_DELISTED: '已下架',
  LISTING_RESTORED: '已恢复',
  USER_RESTRICTED: '已限制发布',
  USER_RESTRICTION_LIFTED: '已解除限制',
  USER_BANNED: '已封禁',
  USER_UNBANNED: '已解除封禁',
}

export const RESTRICTION_TYPE_LABEL: Record<string, string> = {
  PUBLISH_RESTRICT: '限制发布',
  BAN: '封禁',
}

export const RESTRICTION_STATUS_LABEL: Record<string, string> = {
  ACTIVE: '生效中',
  LIFTED: '已解除',
}

export const REPORT_STATUS_LABEL: Record<string, string> = {
  PENDING: '待处理',
  HANDLED: '已受理',
  REJECTED: '已驳回',
}

export const REPORT_TARGET_TYPE_LABEL: Record<string, string> = {
  LISTING: '商品',
  USER: '用户',
}

export const REPORT_REASON_LABEL: Record<string, string> = {
  MISLEADING: '描述不实',
  PROHIBITED: '违禁品',
  FRAUD: '欺诈',
  SPAM: '垃圾信息',
  HARASSMENT: '骚扰',
  IMPERSONATION: '冒充他人',
  ABUSE: '账号滥用',
  OTHER: '其他',
}

export const REPORT_STATUS_TONE: Record<string, 'warning' | 'success' | 'neutral'> = {
  PENDING: 'warning',
  HANDLED: 'success',
  REJECTED: 'neutral',
}

export function statusLabel(map: Record<string, string>, value: string): string {
  return map[value] ?? value
}

/** ISO → `2026-09-12 03:40`；非法输入返回原串。 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 短 id：只显示后 6 位，卡片/表格里省空间。 */
export function shortId(id: string): string {
  return id.slice(-6)
}
