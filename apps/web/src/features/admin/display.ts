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
}

export const AUDIT_TARGET_LABEL: Record<string, string> = {
  USER: '用户',
  LISTING: '商品',
  MODERATION_RECORD: '审核记录',
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
