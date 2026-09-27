import type { NotificationDto } from '@fish/contracts/notifications/schema'
import { ApiError } from '../../lib/api-client'

export type NotificationTarget =
  | { kind: 'listing'; listingId: string }
  | { kind: 'wish'; wishId: string }
  | { kind: 'none' }

/** payload 的目标优先级：先商品，再愿望；空字符串不当作有效目标。 */
export function notificationTarget(item: NotificationDto): NotificationTarget {
  const listingId = item.payload.listingId?.trim()
  if (listingId) return { kind: 'listing', listingId }
  const wishId = item.payload.wishId?.trim()
  if (wishId) return { kind: 'wish', wishId }
  return { kind: 'none' }
}

export function notificationCopy(item: NotificationDto): {
  emoji: string
  title: string
  description: string
} {
  switch (item.type) {
    case 'MATCH':
      return {
        emoji: '🎯',
        title: '许愿有匹配结果',
        description: '找到了一件可能符合你愿望的闲置。',
      }
  }
}

export function notificationReadErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === 'NOTIFICATION_NOT_FOUND') {
    return '通知不存在或已失效'
  }
  return '标记已读失败，请重试'
}

export function notificationTargetErrorMessage(target: NotificationTarget): string | null {
  switch (target.kind) {
    case 'listing':
      return '目标商品已不存在，已留在通知列表'
    case 'wish':
      return '许愿详情将在后续版本开放，已留在通知列表'
    case 'none':
      return null
  }
}
