import { describe, expect, test } from 'bun:test'
import type { NotificationDto } from '@fish/contracts/notifications/schema'
import { ApiError } from '../../lib/api-client'
import {
  notificationCopy,
  notificationReadErrorMessage,
  notificationTarget,
  notificationTargetErrorMessage,
} from './notification-view'

function item(
  payload: NotificationDto['payload'],
  type: NotificationDto['type'] = 'MATCH',
): NotificationDto {
  return {
    id: 'n1',
    type,
    payload,
    readAt: null,
    createdAt: '2026-09-26T00:00:00.000Z',
  }
}

describe('notification view', () => {
  test('MATCH prioritizes a listing target and falls back to a wish target', () => {
    expect(notificationTarget(item({ listingId: 'l1', wishId: 'w1' }))).toEqual({
      kind: 'listing',
      listingId: 'l1',
    })
    expect(notificationTarget(item({ wishId: 'w1' }))).toEqual({ kind: 'wish', wishId: 'w1' })
    expect(notificationTarget(item({ matchId: 'm1' }))).toEqual({ kind: 'none' })
  })

  /*
   * payload 里的 `listingId` 不是万能落点：TX / MODERATION 的 payload 也带它
   * （见 `apps/api/src/app.ts` 与 `moderation/store.ts` 的写入），一律跳商品详情会与
   * 文案承诺的落点打架，且未通过审核的商品详情页本身打不开。
   */
  test('TX 跳会话、MODERATION 跳我的发布，都不按 payload 的 listingId 跳商品', () => {
    expect(notificationTarget(item({ listingId: 'l1', conversationId: 'c1' }, 'TX'))).toEqual({
      kind: 'conversation',
      conversationId: 'c1',
    })
    // TX 缺 conversationId（历史行 / 脏 payload）：不跳，而不是拿 listingId 凑
    expect(notificationTarget(item({ listingId: 'l1' }, 'TX'))).toEqual({ kind: 'none' })
    expect(
      notificationTarget(item({ listingId: 'l1', outcome: 'REJECTED' }, 'MODERATION')),
    ).toEqual({ kind: 'mylist' })
    // ACCOUNT：PC 没有认证页，不给死链接
    expect(
      notificationTarget(item({ subject: 'VERIFICATION', outcome: 'APPROVED' }, 'ACCOUNT')),
    ).toEqual({ kind: 'none' })
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
    // 会话 / 我的发布是静态路由，没有「目标不存在」这一说
    expect(
      notificationTargetErrorMessage({ kind: 'conversation', conversationId: 'c1' }),
    ).toBeNull()
    expect(notificationTargetErrorMessage({ kind: 'mylist' })).toBeNull()
  })

  test('renders the three new types instead of an unknown-type fallback', () => {
    expect(notificationCopy(item({ event: 'PROPOSED' }, 'TX'))).toEqual({
      emoji: '🤝',
      title: '交易有新的进展',
      description: '买家发起了交易确认，等你接受。',
    })
    expect(notificationCopy(item({ listingId: 'l1', outcome: 'APPROVED' }, 'MODERATION'))).toEqual({
      emoji: '✅',
      title: '商品审核通过',
      description: '你的闲置已重新上架可见。',
    })
    expect(notificationCopy(item({ outcome: 'REJECTED' }, 'MODERATION')).title).toBe(
      '商品未通过审核',
    )
    expect(
      notificationCopy(item({ subject: 'VERIFICATION', outcome: 'APPROVED' }, 'ACCOUNT')),
    ).toEqual({ emoji: '🎓', title: '校园认证通过', description: '已完成校园认证。' })
  })

  /*
   * `outcome` 在契约里是**可选**字段（历史行 / 脏 payload 读不到）。只有明确的
   * `REJECTED` 才允许说「未通过」—— 否则缺省值会被渲染成一次并不存在的拒审。
   */
  test('outcome 缺席时不渲染成「未通过」', () => {
    expect(notificationCopy(item({ listingId: 'l1' }, 'MODERATION')).title).toBe('商品审核有更新')
    expect(notificationCopy(item({ listingId: 'l1' }, 'MODERATION')).description).toContain(
      '我的发布',
    )
    expect(notificationCopy(item({ subject: 'VERIFICATION' }, 'ACCOUNT')).title).toBe(
      '认证结果有更新',
    )
  })

  /*
   * TX 的 `event` 是「谁在什么时候学到什么」的唯一信息源：不说事件的话，六种进展
   * （等接受 / 已接受 / 被拒 / 对方已确认 / 已完成 / 已取消）在列表上长得一模一样。
   * `event` 缺席（历史行 / 脏 payload）时退回不含事件信息的通用句，不留空行。
   */
  test('TX 按 event 给不同措辞，事件缺席时退回通用句', () => {
    const descriptionOf = (event: NotificationDto['payload']['event']) =>
      notificationCopy(item({ listingId: 'l1', conversationId: 'c1', event }, 'TX')).description

    expect(descriptionOf('ACCEPTED')).toBe('卖家接受了你的交易确认，去安排面交吧。')
    expect(descriptionOf('REJECTED')).toBe('卖家拒绝了你的交易确认。')
    expect(descriptionOf('CONFIRMED')).toBe('对方已确认面交，等你确认。')
    expect(descriptionOf('COMPLETED')).toBe('交易已完成。')
    expect(descriptionOf('CANCELLED')).toBe('交易已取消。')
    expect(descriptionOf(undefined)).toBe('打开会话查看这笔交易的当前状态。')
  })
})
