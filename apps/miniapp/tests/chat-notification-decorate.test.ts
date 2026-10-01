import { describe, expect, test } from 'bun:test'
import type { NotificationDto } from '@fish/contracts/notifications/schema'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { decorateNotifications } from '../src/mock/api'

/**
 * 通知的展示层组装（`decorateNotifications`）：任务一扩的三类（TX / MODERATION /
 * ACCOUNT）在客户端必须各自给出**非空文案 + 正确的跳转目标**，否则「每条可点、
 * 可跳到对应内容」这条验收就只剩「能编译」。
 *
 * 这里只锁客户端产物（title / description / target / tone）—— 与契约无关，
 * 契约只负责 `type` + `payload`。
 */

const UUID = '0199a000-0000-7000-8000-000000000001'
const notificationId = encodePublicId(PUBLIC_ID_PREFIX.notification, UUID)
const conversationId = encodePublicId(PUBLIC_ID_PREFIX.conversation, UUID)
const listingId = encodePublicId(PUBLIC_ID_PREFIX.listing, UUID)
const transactionId = encodePublicId(PUBLIC_ID_PREFIX.transaction, UUID)

function dto(overrides: Partial<NotificationDto>): NotificationDto {
  return {
    id: notificationId,
    type: 'MATCH',
    payload: {},
    readAt: null,
    createdAt: '2026-09-29T00:00:00.000Z',
    ...overrides,
  }
}

/** 真实接口路径（`resolve = null`）：客户端没有按 listingId 查标题的能力 */
const [decorate] = decorateNotifications(
  [
    dto({ type: 'TX', payload: { event: 'PROPOSED', conversationId, listingId } }),
    dto({ type: 'TX', payload: { event: 'ACCEPTED', conversationId, listingId, transactionId } }),
    dto({ type: 'MODERATION', payload: { listingId, outcome: 'REJECTED' } }),
    dto({ type: 'MODERATION', payload: { listingId, outcome: 'APPROVED' } }),
    dto({ type: 'ACCOUNT', payload: { subject: 'VERIFICATION', outcome: 'APPROVED' } }),
  ],
  null,
)

describe('decorateNotifications —— 任务一的三类通知', () => {
  test('TX 的文案随事件变化，跳转目标是会话', () => {
    expect(decorate?.description).toBe('买家发起了交易确认，等你接受')
    expect(decorate?.target).toEqual({ kind: 'conversation', conversationId })
    expect(decorate?.tone).toBe('warn')
  })

  test('TX 只有 conversationId 缺失时才不给跳转（不拿 listingId 凑）', () => {
    const [noConversation] = decorateNotifications(
      [dto({ type: 'TX', payload: { event: 'ACCEPTED', listingId } })],
      null,
    )
    expect(noConversation?.target).toBeNull()
    expect(noConversation?.description).toBe('卖家接受了你的交易确认，去安排面交吧')
  })

  test('MODERATION 跳「我的发布」，文案按 outcome 分通过 / 未通过', () => {
    const [rejected] = decorateNotifications(
      [dto({ type: 'MODERATION', payload: { listingId, outcome: 'REJECTED' } })],
      null,
    )
    expect(rejected?.title).toBe('商品未通过审核')
    expect(rejected?.target).toEqual({ kind: 'mylist' })
    expect(rejected?.tone).toBe('warn')

    const [approved] = decorateNotifications(
      [dto({ type: 'MODERATION', payload: { listingId, outcome: 'APPROVED' } })],
      null,
    )
    expect(approved?.title).toBe('商品审核通过')
    expect(approved?.tone).toBe('mint')
  })

  test('缺省 outcome 不渲染成「未通过」：只有明确 REJECTED 才算拒绝', () => {
    // 契约里 `outcome` 是**可选**的（`notificationOutcomeSchema.optional()`）：历史行 /
    // 脏 payload 读不到它。把「读不到」渲染成「商品未通过审核」等于替服务端宣布拒审，
    // 而用户看到的可能只是一条旧数据 —— 这条断言锁住三态分支。
    const [moderation, account] = decorateNotifications(
      [
        dto({ type: 'MODERATION', payload: { listingId } }),
        dto({ type: 'ACCOUNT', payload: { subject: 'VERIFICATION' } }),
      ],
      null,
    )
    expect(moderation?.title).toBe('商品审核有更新')
    expect(moderation?.title).not.toBe('商品未通过审核')
    expect(moderation?.target).toEqual({ kind: 'mylist' })
    expect(account?.title).not.toBe('校园认证未通过')
    expect(account?.description).not.toBe('校园认证未通过，可重新验证')
    expect(moderation?.description.length).toBeGreaterThan(0)
    expect(account?.description.length).toBeGreaterThan(0)
  })

  test('ACCOUNT 跳校园认证页', () => {
    const [account] = decorateNotifications(
      [dto({ type: 'ACCOUNT', payload: { subject: 'VERIFICATION', outcome: 'APPROVED' } })],
      null,
    )
    expect(account?.title).toBe('校园认证')
    expect(account?.target).toEqual({ kind: 'verify' })
    expect(account?.tone).toBe('mint')
  })

  test('三类通知的文案都不为空（否则通知 tab 只显示一行标题）', () => {
    const items = decorateNotifications(
      [
        dto({ type: 'TX', payload: { event: 'CONFIRMED', conversationId } }),
        dto({ type: 'TX', payload: { event: 'COMPLETED', conversationId } }),
        dto({ type: 'TX', payload: { event: 'CANCELLED', conversationId } }),
        dto({ type: 'TX', payload: { event: 'REJECTED', conversationId } }),
        dto({ type: 'MODERATION', payload: { outcome: 'APPROVED' } }),
        dto({ type: 'ACCOUNT', payload: { subject: 'VERIFICATION', outcome: 'REJECTED' } }),
      ],
      null,
    )
    for (const item of items) {
      expect(item.title.length).toBeGreaterThan(0)
      expect(item.description.length).toBeGreaterThan(0)
    }
  })
})
