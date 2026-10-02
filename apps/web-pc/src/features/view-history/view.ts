import type { ListingCard } from '@fish/contracts/listings/schema'
import type { ViewHistoryItem } from '@fish/contracts/view-history/schema'

/** 一天一组：日期取**足迹时间**的本地日（不是商品发布时间）。 */
export type HistoryDayGroup = { date: string; items: ViewHistoryItem[] }

/** 本地时区的 `YYYY-MM-DD`。契约时间戳是 UTC ISO，分组必须换算到用户本地日。 */
export function localDayKey(iso: string): string {
  const date = new Date(iso)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * 按本地日分组，保持输入顺序（服务端已按 `viewedAt` 倒序，组内同序）。
 * 不做排序：列表顺序是服务端契约的一部分，端上重排会掩盖游标错乱。
 */
export function groupHistoryByDay(items: readonly ViewHistoryItem[]): HistoryDayGroup[] {
  const groups: HistoryDayGroup[] = []
  for (const item of items) {
    const date = localDayKey(item.viewedAt)
    const last = groups.at(-1)
    if (last !== undefined && last.date === date) {
      last.items.push(item)
    } else {
      groups.push({ date, items: [item] })
    }
  }
  return groups
}

/** 分组标题：今天 / 昨天 / `M月D日`（跨年时带年份，避免「1月1日」指向不明）。 */
export function historyDayLabel(dayKey: string, now: Date): string {
  if (dayKey === localDayKey(now.toISOString())) return '今天'
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1_000)
  if (dayKey === localDayKey(yesterday.toISOString())) return '昨天'

  const [year, month, day] = dayKey.split('-').map(Number)
  const sameYear = year === now.getFullYear()
  return sameYear ? `${month}月${day}日` : `${year}年${month}月${day}日`
}

/**
 * 失效状态沿用商品状态，不新增「是否失效」字段（与收藏页同一口径）：
 * 足迹行不随商品状态消失，端上读 `status` 自己决定怎么展示。
 */
const STATUS_VIEW: Record<
  ListingCard['status'],
  { label: string; variant: 'brand' | 'secondary' | 'warn' | 'success' }
> = {
  ACTIVE: { label: '在售', variant: 'success' },
  RESERVED: { label: '已预定', variant: 'warn' },
  SOLD: { label: '已售出', variant: 'brand' },
  OFFLINE: { label: '已下架', variant: 'secondary' },
}

export function historyStatusView(status: ListingCard['status']): {
  label: string
  variant: 'brand' | 'secondary' | 'warn' | 'success'
} {
  return STATUS_VIEW[status]
}

/**
 * 个人中心计数卡的取值：读不到（请求失败 / 还没拿到）显示「未知」而不是 0 ——
 * 0 是"确实没看过"，与"不知道"是两件事（收藏 / 关注计数卡同一取舍）。
 */
export function historyCountLabel(total: number | undefined, failed: boolean): number | string {
  if (failed || total === undefined) return '未知'
  return total
}
