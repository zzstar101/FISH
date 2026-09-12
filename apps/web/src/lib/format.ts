/** 价格：整数分 → `¥1,580` / `免费送`。契约里价格一律是整数分（#6）。 */
export function formatPrice(cents: number): string {
  if (cents === 0) return '免费送'
  const yuan = cents / 100
  return `¥${yuan % 1 === 0 ? yuan.toLocaleString('zh-CN') : yuan.toFixed(2)}`
}

/** 只要数字部分（详情页大号价格旁边要单独放 ¥）。 */
export function formatYuan(cents: number): string {
  const yuan = cents / 100
  return yuan % 1 === 0 ? yuan.toLocaleString('zh-CN') : yuan.toFixed(2)
}

/**
 * 折扣：`6.3折`；没有原价、原价不高于现价、或本身就是免费送时为 null。
 *
 * 免费送必须在这里短路：`priceCents === 0` 时按公式算出来是没意义的 `0.0折`
 * （0 元的东西谈不上几折），详情页会把它渲染在「免费送」大字的旁边。
 */
export function formatDiscount(priceCents: number, originalCents?: number): string | null {
  if (priceCents === 0) return null
  if (!originalCents || originalCents <= priceCents) return null
  const ratio = (priceCents / originalCents) * 10
  return `${ratio.toFixed(1)}折`
}

/** 相对时间：`刚刚 / 25分钟前 / 3小时前 / 昨天 / 5天前`。 */
export function formatRelativeTime(minutesAgo: number): string {
  if (minutesAgo < 1) return '刚刚'
  if (minutesAgo < 60) return `${Math.round(minutesAgo)}分钟前`
  if (minutesAgo < 60 * 24) return `${Math.round(minutesAgo / 60)}小时前`
  if (minutesAgo < 60 * 24 * 2) return '昨天'
  return `${Math.round(minutesAgo / (60 * 24))}天前`
}

/**
 * Mock 数据里的时间都是「距今多少分钟」，需要一个固定锚点才能算出 HH:mm。
 * 取 09:42 —— 与参考截图里最后一条消息的时间一致。
 */
const NOW_MINUTE_OF_DAY = 9 * 60 + 42

function minuteOfDay(minutesAgo: number): number {
  return (((NOW_MINUTE_OF_DAY - minutesAgo) % 1440) + 1440) % 1440
}

/** 会话列表用的时间：今天给 HH:mm，昨天/前天，更早给星期。 */
export function formatChatTime(minutesAgo: number): string {
  const days = Math.floor(minutesAgo / (60 * 24))
  if (days === 0 && minutesAgo < 60 * 12) {
    const day = minuteOfDay(minutesAgo)
    return `${String(Math.floor(day / 60)).padStart(2, '0')}:${String(day % 60).padStart(2, '0')}`
  }
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days === 2) return '前天'
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][days % 7] as string
}

/** 消息气泡下方的时间（HH:mm）。 */
export function formatClock(minutesAgo: number): string {
  return formatChatTime(minutesAgo)
}

/** 消息分组的日期标题：近一天统一显示「今天」。 */
export function formatMessageDay(minutesAgo: number): string {
  const days = Math.floor(minutesAgo / (60 * 24))
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  return formatRelativeTime(minutesAgo)
}

/** 关注时间：当天较早的显示「今天 HH:mm关注」，近处显示相对时间（截图 08-watchers）。 */
export function formatFollowTime(minutesAgo: number): string {
  if (minutesAgo >= 60 * 8 && minutesAgo < 60 * 24) {
    return `今天 ${formatClock(minutesAgo)}关注`
  }
  return `${formatRelativeTime(minutesAgo)}关注`
}
