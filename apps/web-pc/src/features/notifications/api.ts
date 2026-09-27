import { NOTIFICATION_ROUTES } from '@fish/contracts/notifications/routes'
import {
  type NotificationDto,
  type NotificationListResponse,
  notificationDtoSchema,
  notificationListResponseSchema,
  notificationUnreadCountSchema,
} from '@fish/contracts/notifications/schema'
import { apiRequest } from '../../lib/api-client'

export const NOTIFICATION_PAGE_LIMIT = 50

export async function fetchNotifications(
  limit = NOTIFICATION_PAGE_LIMIT,
): Promise<NotificationListResponse> {
  const payload = await apiRequest(`${NOTIFICATION_ROUTES.base}?limit=${limit}`)
  return notificationListResponseSchema.parse(payload)
}

export async function fetchUnreadNotificationCount(): Promise<number> {
  const payload = await apiRequest(NOTIFICATION_ROUTES.unreadCount)
  return notificationUnreadCountSchema.parse(payload).unreadCount
}

/** 标记单条通知已读；服务端幂等，返回更新后的通知。 */
export async function markNotificationRead(id: string): Promise<NotificationDto> {
  const payload = await apiRequest(NOTIFICATION_ROUTES.markRead(id), { method: 'POST' })
  return notificationDtoSchema.parse(payload)
}
