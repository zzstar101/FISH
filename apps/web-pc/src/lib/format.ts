/** 价格：整数分 → `¥1,580` / `免费送`。契约里价格一律是整数分（#6）。 */
export function formatPrice(cents: number): string {
  if (cents === 0) return '免费送'
  const yuan = cents / 100
  return `¥${yuan % 1 === 0 ? yuan.toLocaleString('zh-CN') : yuan.toFixed(2)}`
}

/** 相对时间：`刚刚 / 25分钟前 / 3小时前 / 昨天 / 5天前`。 */
function formatRelativeTime(minutesAgo: number): string {
  if (minutesAgo < 1) return '刚刚'
  if (minutesAgo < 60) return `${Math.round(minutesAgo)}分钟前`
  if (minutesAgo < 60 * 24) return `${Math.round(minutesAgo / 60)}小时前`
  if (minutesAgo < 60 * 24 * 2) return '昨天'
  return `${Math.round(minutesAgo / (60 * 24))}天前`
}

/** 距今的分钟数；时钟偏移导致未来时间时按 0 处理（显示「刚刚」）。 */
function minutesSince(iso: string): number {
  const elapsed = (Date.now() - new Date(iso).getTime()) / 60_000
  return Number.isFinite(elapsed) ? Math.max(elapsed, 0) : 0
}

export function formatRelativeTimeAt(iso: string): string {
  return formatRelativeTime(minutesSince(iso))
}
