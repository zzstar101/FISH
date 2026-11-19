import type { ICONS } from '@/assets/lib-icons'
import { localDayIndex } from '@/lib/time'
import type { MockNotification } from '@/mock/types'

type Appearance = {
  title: string
  description: string
  icon: keyof typeof ICONS
  variant: 'brand' | 'success' | 'attention'
  status: string | null
}

/** 事件是历史记录，不据此推断交易当前状态；尤其不能把未读当成待处理。 */
export function notificationAppearance(item: MockNotification): Appearance {
  const base: Appearance = {
    title: item.title,
    description: item.description,
    icon: 'bellFg',
    variant: 'brand',
    status: null,
  }
  if (item.type === 'TX') {
    switch (item.payload.event) {
      case 'PROPOSED':
        return { ...base, title: '交易确认邀请', icon: 'shieldCheckBrand', variant: 'attention' }
      case 'ACCEPTED':
        return { ...base, title: '交易确认已接受', icon: 'checkDoubleBrand' }
      case 'CONFIRMED':
        return { ...base, title: '对方已确认面交', icon: 'shieldCheckBrand' }
      case 'COMPLETED':
        return {
          ...base,
          title: '交易已完成',
          description: '这次闲置，找到了新主人',
          icon: 'checkCircleBrand',
          variant: 'success',
          status: '已完成',
        }
      case 'REJECTED':
        return { ...base, title: '交易确认被拒绝', icon: 'infoMuted' }
      case 'CANCELLED':
        return { ...base, title: '交易已取消', icon: 'infoMuted' }
    }
  }
  if (item.type === 'ACCOUNT' && item.payload.subject === 'VERIFICATION') {
    const approved = item.payload.outcome === 'APPROVED'
    return {
      ...base,
      title: approved
        ? '校园认证通过'
        : item.payload.outcome === 'REJECTED'
          ? '校园认证未通过'
          : '校园认证有更新',
      icon: 'verifiedBrand',
      variant: approved ? 'success' : 'attention',
    }
  }
  if (item.type === 'MATCH') return { ...base, icon: 'sparkleBrand' }
  if (item.type === 'MODERATION') {
    return {
      ...base,
      icon: 'shieldCheckBrand',
      variant: item.payload.outcome === 'APPROVED' ? 'success' : 'attention',
    }
  }
  if (item.type === 'DISPUTE') {
    return {
      ...base,
      icon: 'shieldCheckBrand',
      variant: item.payload.disputeEvent === 'RESOLVED' ? 'success' : 'attention',
    }
  }
  return base
}

type NotificationGroup = { key: string; label: string; items: MockNotification[] }

/** 最多突出一条未读邀请，其余按本地日历日归组；不改动接口的原数组。 */
export function notificationFeed(items: MockNotification[], now: number) {
  const sorted = [...items].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  )
  const featured = sorted.find(
    (item) =>
      item.type === 'TX' &&
      item.payload.event === 'PROPOSED' &&
      item.readAt === null &&
      item.target !== null,
  )
  const groups: NotificationGroup[] = []
  for (const item of sorted) {
    if (item.id === featured?.id) continue
    const timestamp = Date.parse(item.createdAt)
    const day = localDayIndex(timestamp)
    const key = Number.isFinite(day) ? String(day) : 'unknown'
    let group = groups.find((entry) => entry.key === key)
    if (!group) {
      const days = Math.max(0, localDayIndex(now) - day)
      const label = !Number.isFinite(day)
        ? '更早动态'
        : days === 0
          ? '今天'
          : days === 1
            ? '昨天'
            : `${days} 天前`
      group = { key, label, items: [] }
      groups.push(group)
    }
    group.items.push(item)
  }
  return { featured, groups }
}
