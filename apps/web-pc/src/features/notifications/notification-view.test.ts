import { describe, expect, test } from 'bun:test'
import type { NotificationDto } from '@fish/contracts/notifications/schema'
import { ApiError } from '../../lib/api-client'
import {
  notificationCopy,
  notificationReadErrorMessage,
  notificationTarget,
  notificationTargetErrorMessage,
} from './notification-view'

function item(payload: NotificationDto['payload']): NotificationDto {
  return {
    id: 'n1',
    type: 'MATCH',
    payload,
    readAt: null,
    createdAt: '2026-09-26T00:00:00.000Z',
  }
}

describe('notification view', () => {
  test('prioritizes a listing target and falls back to a wish target', () => {
    expect(notificationTarget(item({ listingId: 'l1', wishId: 'w1' }))).toEqual({
      kind: 'listing',
      listingId: 'l1',
    })
    expect(notificationTarget(item({ wishId: 'w1' }))).toEqual({ kind: 'wish', wishId: 'w1' })
    expect(notificationTarget(item({ matchId: 'm1' }))).toEqual({ kind: 'none' })
  })

  test('renders MATCH copy and keeps fallback messages explicit', () => {
    expect(notificationCopy(item({ matchId: 'm1' }))).toEqual({
      emoji: '🎯',
      title: '许愿有匹配结果',
      description: '找到了一件可能符合你愿望的闲置。',
    })
    expect(
      notificationReadErrorMessage(new ApiError('NOTIFICATION_NOT_FOUND', 404, '通知不存在')),
    ).toBe('通知不存在或已失效')
    expect(notificationReadErrorMessage(new Error('network'))).toBe('标记已读失败，请重试')
    expect(notificationTargetErrorMessage({ kind: 'wish', wishId: 'w1' })).toBe(
      '许愿详情将在后续版本开放，已留在通知列表',
    )
  })
})
