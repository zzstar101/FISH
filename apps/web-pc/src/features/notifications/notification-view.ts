import type { NotificationDto } from '@fish/contracts/notifications/schema'
import { ApiError } from '../../lib/api-client'

export type NotificationTarget =
  | { kind: 'listing'; listingId: string }
  | { kind: 'wish'; wishId: string }
  /** TX：会话详情（`/messages/:conversationId`），PC 有这一页 */
  | { kind: 'conversation'; conversationId: string }
  /** MODERATION：我的发布（`/mylist`）—— 未通过时原因在那里 */
  | { kind: 'mylist' }
  | { kind: 'none' }

/**
 * 点击通知跳到哪。**按 `type` 分流**：payload 里的 `listingId` 不是万能落点 ——
 * TX / MODERATION 的 payload 也带 `listingId`，一律跳商品详情会与文案承诺的落点
 * 打架（TX 的进展在会话里、MODERATION 的原因在「我的发布」），且未通过审核的商品
 * 详情页本身打不开。空字符串不当作有效目标。
 */
export function notificationTarget(item: NotificationDto): NotificationTarget {
  switch (item.type) {
    case 'TX': {
      const conversationId = item.payload.conversationId?.trim()
      return conversationId ? { kind: 'conversation', conversationId } : { kind: 'none' }
    }
    case 'MODERATION':
      return { kind: 'mylist' }
    // ACCOUNT：PC 没有认证页，文案只陈述结果，不给死链接。
    case 'ACCOUNT':
      return { kind: 'none' }
    case 'MATCH': {
      const listingId = item.payload.listingId?.trim()
      if (listingId) return { kind: 'listing', listingId }
      const wishId = item.payload.wishId?.trim()
      if (wishId) return { kind: 'wish', wishId }
      return { kind: 'none' }
    }
  }
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
    // 任务一扩展的三类：文案与 `notificationTarget` 的落点必须一致（见那里的注释）。
    case 'TX':
      return {
        emoji: '🤝',
        title: '交易有新的进展',
        description: '打开会话查看这笔交易的当前状态。',
      }
    case 'MODERATION':
      return item.payload.outcome === 'APPROVED'
        ? { emoji: '✅', title: '商品审核通过', description: '你的闲置已重新上架可见。' }
        : { emoji: '⚠️', title: '商品未通过审核', description: '到「我的发布」查看原因。' }
    case 'ACCOUNT':
      return item.payload.outcome === 'APPROVED'
        ? { emoji: '🎓', title: '校园认证通过', description: '已完成校园认证。' }
        : { emoji: '⚠️', title: '校园认证未通过', description: '可以重新提交验证。' }
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
    case 'conversation':
    case 'mylist':
    case 'none':
      return null
  }
}
