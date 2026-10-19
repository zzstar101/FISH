import { describe, expect, test } from 'bun:test'
import type { DisputeStatus } from '@fish/contracts/disputes/schema'
import type { TransactionStatus } from '@fish/contracts/transactions/schema'
import {
  canAddDisputeAttachment,
  canStartDispute,
  canSupplementDispute,
  canWithdrawDispute,
  disputeCounterpart,
  disputeFailureText,
  disputeMessagePreview,
  disputeViewerRole,
  shortDisputeId,
} from './view'

const COMPLETED_AT = '2026-10-12T00:00:00.000Z'
const COMPLETED_MS = Date.parse(COMPLETED_AT)
const DAY_MS = 24 * 60 * 60 * 1000

function transaction(
  status: TransactionStatus,
  overrides: { completedAt?: string | null; cancelledAt?: string | null } = {},
) {
  return {
    status,
    completedAt: overrides.completedAt ?? null,
    cancelledAt: overrides.cancelledAt ?? null,
  }
}

describe('canStartDispute', () => {
  test('PENDING_MEETUP 的交易没有发起时限', () => {
    expect(canStartDispute(transaction('PENDING_MEETUP'), COMPLETED_MS + 365 * DAY_MS)).toBe(true)
  })

  test('已成交交易只在终态后 30 天内可发起（含边界当天）', () => {
    const completed = transaction('COMPLETED', { completedAt: COMPLETED_AT })
    expect(canStartDispute(completed, COMPLETED_MS + 29 * DAY_MS)).toBe(true)
    expect(canStartDispute(completed, COMPLETED_MS + 30 * DAY_MS)).toBe(true)
    // 服务端规则是 `now - closedAt > 窗口` 才拒，窗口最后 1ms 仍允许
    expect(canStartDispute(completed, COMPLETED_MS + 30 * DAY_MS + 1)).toBe(false)
  })

  test('已取消交易按取消时间算同一个窗口', () => {
    const cancelled = transaction('CANCELLED', { cancelledAt: COMPLETED_AT })
    expect(canStartDispute(cancelled, COMPLETED_MS + DAY_MS)).toBe(true)
    expect(canStartDispute(cancelled, COMPLETED_MS + 31 * DAY_MS)).toBe(false)
  })

  test('终态时间缺失或不可解析时不放行，交给服务端兜底', () => {
    expect(canStartDispute(transaction('COMPLETED'), COMPLETED_MS)).toBe(false)
    expect(canStartDispute(transaction('CANCELLED'), COMPLETED_MS)).toBe(false)
    expect(
      canStartDispute(transaction('COMPLETED', { completedAt: 'not-a-date' }), COMPLETED_MS),
    ).toBe(false)
  })
})

describe('disputeFailureText', () => {
  test('按契约错误码给固定文案，其余给通用重试文案', () => {
    expect(disputeFailureText('DISPUTE_TRANSACTION_NOT_FOUND')).toBe(
      '订单不存在，或你不是这笔交易的买卖双方',
    )
    expect(disputeFailureText('DISPUTE_NOT_FOUND')).toBe('争议不存在，或你无权查看')
    expect(disputeFailureText('DISPUTE_MESSAGE_NOT_FOUND')).toBe(
      '这条消息不属于本交易的会话，无法作为证据',
    )
    expect(disputeFailureText('DISPUTE_WINDOW_CLOSED')).toContain('30 天')
    expect(disputeFailureText('DISPUTE_CONFLICT')).toBe('争议状态刚发生变化，请刷新后再试')
    expect(disputeFailureText('DISPUTE_ATTACHMENT_LIMIT')).toBe('最多上传 6 张图片')
    expect(disputeFailureText('DISPUTE_ATTACHMENT_INVALID')).toContain('图片校验失败')
    expect(disputeFailureText('DISPUTE_NOT_PENDING')).toBe('争议已处理或已撤回，不能再补充材料')
    expect(disputeFailureText('VALIDATION_FAILED')).toBe('填写的内容不合法，请检查后重试')
    expect(disputeFailureText('UNAUTHENTICATED')).toContain('登录已过期')
    // 非 ApiError（网络 / 契约解析失败）与未知 code
    expect(disputeFailureText(null)).toBe('操作失败，请稍后再试')
    expect(disputeFailureText('SOMETHING_ELSE')).toBe('操作失败，请稍后再试')
  })
})

describe('shortDisputeId', () => {
  test('短 id 原样保留，长 id 截成首尾片段', () => {
    expect(shortDisputeId('dsp_short')).toBe('dsp_short')
    expect(shortDisputeId('dsp_01JC000000E00800000000000A')).toBe('dsp_01JC0…000A')
  })
})

describe('disputeMessagePreview', () => {
  test('系统消息翻译成中文事件，不把协议 JSON 当证据文案', () => {
    expect(
      disputeMessagePreview({
        type: 'SYSTEM',
        content:
          '{"type":"tx.accepted","transactionId":"txn_01jc000000e00800000000000a","amountCents":2800}',
        recalledAt: null,
      }),
    ).toBe('交易已接受，待面交')
    // 证据投影未做公开 ID 转换时（裸 UUID），不把协议 JSON 漏成用户文案
    expect(
      disputeMessagePreview({
        type: 'SYSTEM',
        content:
          '{"type":"tx.accepted","transactionId":"01930000-0000-7000-8000-000000000051","amountCents":2800}',
        recalledAt: null,
      }),
    ).toBe('系统消息（交易状态更新）')
  })

  test('撤回优先于类型，图片 / 商品卡片有占位文案，空文本有兜底', () => {
    expect(
      disputeMessagePreview({
        type: 'SYSTEM',
        content: 'x',
        recalledAt: '2026-10-02T00:00:00.000Z',
      }),
    ).toBe('（消息已撤回）')
    expect(disputeMessagePreview({ type: 'MEDIA', content: '', recalledAt: null })).toBe(
      '[图片或视频]',
    )
    expect(disputeMessagePreview({ type: 'LISTING', content: '', recalledAt: null })).toBe(
      '[商品卡片]',
    )
    expect(disputeMessagePreview({ type: 'TEXT', content: '有划痕', recalledAt: null })).toBe(
      '有划痕',
    )
    expect(disputeMessagePreview({ type: 'TEXT', content: '   ', recalledAt: null })).toBe(
      '（无文字内容）',
    )
  })
})

const INITIATOR = { id: 'usr_initiator', nickname: '阿岚' } as const
const RESPONDENT = { id: 'usr_respondent', nickname: '小北' } as const

function dispute(status: DisputeStatus) {
  return { status, initiator: INITIATOR }
}

describe('viewer role / counterpart / 可操作权限', () => {
  test('角色与「对方」按查看者是谁切换', () => {
    expect(disputeViewerRole(dispute('PENDING'), INITIATOR.id)).toBe('initiator')
    expect(disputeViewerRole(dispute('PENDING'), RESPONDENT.id)).toBe('respondent')

    const both = { initiator: INITIATOR, respondent: RESPONDENT }
    expect(disputeCounterpart(both, INITIATOR.id)).toEqual(RESPONDENT)
    expect(disputeCounterpart(both, RESPONDENT.id)).toEqual(INITIATOR)
  })

  test('撤回 / 补材料只属于发起人，且只在 PENDING', () => {
    expect(canWithdrawDispute(dispute('PENDING'), INITIATOR.id)).toBe(true)
    expect(canWithdrawDispute(dispute('PENDING'), RESPONDENT.id)).toBe(false)
    expect(canWithdrawDispute(dispute('RESOLVED'), INITIATOR.id)).toBe(false)

    expect(canSupplementDispute(dispute('PENDING'), INITIATOR.id)).toBe(true)
    expect(canSupplementDispute(dispute('PENDING'), RESPONDENT.id)).toBe(false)
    expect(canSupplementDispute(dispute('WITHDRAWN'), INITIATOR.id)).toBe(false)
  })

  test('附件配额在 6 张处关闭，被诉方永远不能加', () => {
    const pending = dispute('PENDING')
    expect(canAddDisputeAttachment(pending, INITIATOR.id, 5)).toBe(true)
    expect(canAddDisputeAttachment(pending, INITIATOR.id, 6)).toBe(false)
    expect(canAddDisputeAttachment(pending, RESPONDENT.id, 0)).toBe(false)
  })
})
