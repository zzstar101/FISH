import { describe, expect, test } from 'bun:test'
import { type NotificationDto, notificationTypeSchema } from '@fish/contracts/notifications/schema'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { decorateNotifications } from '../src/mock/api'

/**
 * `decorate.ts` 的**全类型覆盖**守卫（#465）。
 *
 * 背景：`decorateNotification` 是一条 if 链 + 末尾兜底 `{ title: '新通知', description: '' }`。
 * 契约新增 `notificationTypeSchema` 取值时，谁都不会编译失败 —— 新类型的通知会静默退化成
 * 「新通知」+ 空描述。这条用例把「枚举里每一个 type 都必须有专属分支」变成断言：
 * 谁扩枚举就得在这里补 payload，从而被迫看一眼 `decorate.ts`。
 */

const UUID = '0199a000-0000-7000-8000-000000000001'
const otherUuid = '0199a000-0000-7000-8000-000000000002'
const notificationId = encodePublicId(PUBLIC_ID_PREFIX.notification, UUID)
const listingId = encodePublicId(PUBLIC_ID_PREFIX.listing, UUID)
const wishId = encodePublicId(PUBLIC_ID_PREFIX.wish, otherUuid)
const conversationId = encodePublicId(PUBLIC_ID_PREFIX.conversation, UUID)
const transactionId = encodePublicId(PUBLIC_ID_PREFIX.transaction, UUID)
const disputeId = encodePublicId(PUBLIC_ID_PREFIX.dispute, UUID)

function dto(overrides: Partial<NotificationDto>): NotificationDto {
  return {
    id: notificationId,
    type: 'MATCH',
    payload: {},
    readAt: null,
    createdAt: '2026-10-06T00:00:00.000Z',
    ...overrides,
  }
}

/** 兜底文案：任何 type 只要落到它，就说明 `decorate.ts` 缺一个分支。 */
const FALLBACK_TITLE = '新通知'

const sampleByType: Record<NotificationDto['type'], NotificationDto> = {
  MATCH: dto({ type: 'MATCH', payload: { matchId: notificationId, listingId, wishId } }),
  TX: dto({ type: 'TX', payload: { event: 'COMPLETED', conversationId, listingId } }),
  MODERATION: dto({ type: 'MODERATION', payload: { listingId, outcome: 'APPROVED' } }),
  ACCOUNT: dto({ type: 'ACCOUNT', payload: { subject: 'VERIFICATION', outcome: 'APPROVED' } }),
  DISPUTE: dto({
    type: 'DISPUTE',
    payload: { disputeId, transactionId, disputeEvent: 'FILED' },
  }),
}

describe('decorateNotifications —— 契约枚举的每个 type 都有专属分支', () => {
  test('notificationTypeSchema 的每个取值都在用例里（扩枚举时这里会先红）', () => {
    expect(Object.keys(sampleByType).sort()).toEqual([...notificationTypeSchema.options].sort())
  })

  test('每个 type 都不落到「新通知」兜底（真实接口路径 resolve = null）', () => {
    for (const type of notificationTypeSchema.options) {
      const [item] = decorateNotifications([sampleByType[type]], null)
      expect(item?.title).not.toBe(FALLBACK_TITLE)
      // MATCH 在 `resolve === null`（真实接口没有查标题的能力）时刻意给空描述：
      // 拿不到标题就说「已被下架」是把「不知道」说成「不存在」，见 decorate.ts 注释。
      if (type !== 'MATCH') {
        expect(item?.description.length ?? 0).toBeGreaterThan(0)
      }
    }
  })
})

describe('DISPUTE 通知（#465）', () => {
  test('三种 disputeEvent 各有文案；RESOLVED 是 mint，其余 warn', () => {
    const [filed] = decorateNotifications(
      [dto({ type: 'DISPUTE', payload: { disputeId, transactionId, disputeEvent: 'FILED' } })],
      null,
    )
    expect(filed?.title).toBe('交易争议有更新')
    expect(filed?.description).toBe('对方就这笔交易发起了争议')
    expect(filed?.tone).toBe('warn')

    const [withdrawn] = decorateNotifications(
      [dto({ type: 'DISPUTE', payload: { disputeId, transactionId, disputeEvent: 'WITHDRAWN' } })],
      null,
    )
    expect(withdrawn?.description).toBe('对方撤回了这笔交易的争议')

    const [resolved] = decorateNotifications(
      [
        dto({
          type: 'DISPUTE',
          payload: { disputeId, transactionId, disputeEvent: 'RESOLVED', resolution: 'UPHELD' },
        }),
      ],
      null,
    )
    expect(resolved?.description).toBe('争议已处理，该结论为最终结论')
    expect(resolved?.tone).toBe('mint')
  })

  test('disputeEvent 缺席（历史行 / 脏 payload）给中性句，不编事件', () => {
    const [item] = decorateNotifications(
      [dto({ type: 'DISPUTE', payload: { disputeId, transactionId } })],
      null,
    )
    expect(item?.description).toBe('这笔交易的争议状态有变化')
  })

  test('不给跳转目标：用户侧争议页属 PR C，小程序当前没有这个页面', () => {
    for (const disputeEvent of ['FILED', 'WITHDRAWN', 'RESOLVED'] as const) {
      const [item] = decorateNotifications(
        [dto({ type: 'DISPUTE', payload: { disputeId, transactionId, disputeEvent } })],
        null,
      )
      expect(item?.target).toBeNull()
    }
  })
})
