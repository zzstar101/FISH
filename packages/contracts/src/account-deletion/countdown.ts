/**
 * 冷静期倒计时的**唯一实现**（Issue #464）。
 *
 * 为什么放在契约域：PC 站与小程序必须给出**同一天数、同一句文案**（`./copy.ts` 已声明
 * 两端文案「必须逐字一致」）。此前两端各写一份 `DAY_MS` + `Math.ceil`，连兜底文案都各写
 * 一份，口径已经开始漂移：同一份数据一端说「冷静期已到期」、另一端说「冷静期内」。
 *
 * 天数只由 `purgeScheduledAt` 反算，不本地记「提交时刻 + 7 天」：换设备、重新登录、刷新
 * 页面后本地计时都会丢，而服务端时间戳是唯一权威（也是 worker 真正执行去标识化的依据）。
 */

const DAY_MS = 24 * 60 * 60 * 1000

function parseDue(purgeScheduledAt: string | null): number | null {
  if (purgeScheduledAt === null) return null
  const due = Date.parse(purgeScheduledAt)
  return Number.isNaN(due) ? null : due
}

/**
 * 冷静期剩余天数（向上取整：还剩 30 分钟也应显示「1 天」，显示「0 天」会让人以为已经注销）。
 *
 * `purgeScheduledAt` 为 null（CHECK 约束下不该出现）或解析失败时回 0。**读不到**与
 * **已到期**在这一层同值，区分它们的责任在 {@link coolingOffLabel}：只有后者能把
 * 「没有时间戳」渲染成「冷静期内」，而不是「账号即将被注销」。
 */
export function coolingOffRemainingDays(purgeScheduledAt: string | null, nowMs: number): number {
  const due = parseDue(purgeScheduledAt)
  if (due === null) return 0
  return Math.max(0, Math.ceil((due - nowMs) / DAY_MS))
}

/**
 * 冷静期文案。两端（PC 的 `account-deletion-card` 与小程序注销页）都渲染这一句。
 *
 * 读不到到期时间时只说「冷静期内」：状态确实是 DELETION_REQUESTED，只是这一屏拿不到
 * 时间戳，此时说「账号即将被注销」是拿不确定性吓用户。
 */
export function coolingOffLabel(purgeScheduledAt: string | null, nowMs: number): string {
  if (parseDue(purgeScheduledAt) === null) return '冷静期内'
  const days = coolingOffRemainingDays(purgeScheduledAt, nowMs)
  if (days <= 0) return '冷静期已到期，账号即将被注销'
  return `冷静期剩余 ${days} 天`
}
