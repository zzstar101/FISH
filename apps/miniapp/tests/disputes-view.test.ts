import { describe, expect, test } from 'bun:test'
import {
  type Dispute,
  DisputeErrorCodeSchema,
  DisputeResolutionSchema,
  DisputeStatusSchema,
  DisputeTypeSchema,
} from '@fish/contracts/disputes/schema'
import { disputeToRecord } from '@/features/disputes/map'
import {
  DISPUTE_ERROR_COPY,
  DISPUTE_NOT_PENDING_WITHDRAW_COPY,
  DISPUTE_RESOLUTION_META,
  DISPUTE_STATUS_META,
  DISPUTE_TYPE_META,
  DISPUTE_TYPE_ORDER,
  disputeFailureText,
  shortDisputeId,
} from '@/features/disputes/meta'
import {
  attachmentActionLabel,
  attachmentSlotsLeft,
  canAddDisputeMaterial,
  canWithdrawDispute,
  disputeEntryCopyOf,
  disputeEntryOf,
  disputeNotFoundCopy,
  disputeRoleOf,
  disputeWindowClosed,
  pickDisputeForTransaction,
} from '@/features/disputes/view'

/**
 * 争议页面的纯判定/文案（#497）。
 *
 * 这里守的是三类「不会在 typecheck 里响」的错：
 * ① 我与对方的角色、撤回/补材料按钮的权限口径（错了会看到点了必然 409 的按钮）；
 * ② 30 天发起窗口与服务端 `isWindowClosed` 必须同公式（错一天就多给/少给入口）；
 * ③ 契约枚举漏一个中文标签（Record 已钉完整性，这里再兜一层测试断言）。
 */

const ME = 'usr_me'
const PEER = 'usr_peer'

const DAY_MS = 86_400_000
const NOW = Date.parse('2026-10-20T12:00:00.000Z')

function dispute(overrides: Partial<Dispute> = {}): Dispute {
  return {
    id: 'dsp_0199a00000007000800000' as Dispute['id'],
    type: 'ITEM_MISMATCH',
    status: 'PENDING',
    detailText: '收到的耳机缺一只耳塞',
    initiator: { id: ME as Dispute['initiator']['id'], nickname: '买家小周' },
    respondent: { id: PEER as Dispute['respondent']['id'], nickname: '卖家小林' },
    transaction: {
      id: 'txn_0199a00000007000800000' as Dispute['transaction']['id'],
      listingId: 'lst_0199a00000007000800000' as Dispute['transaction']['listingId'],
      listingTitle: '索尼降噪耳机',
      buyer: { id: ME as Dispute['initiator']['id'], nickname: '买家小周' },
      seller: { id: PEER as Dispute['respondent']['id'], nickname: '卖家小林' },
      amountCents: 32000,
      status: 'COMPLETED',
      completedAt: '2026-10-01T02:00:00.000Z',
      cancelledAt: null,
      createdAt: '2026-09-28T02:00:00.000Z',
    },
    resolution: null,
    resolutionNote: null,
    handledBy: null,
    handledAt: null,
    withdrawnAt: null,
    createdAt: '2026-10-02T02:00:00.000Z',
    updatedAt: '2026-10-02T02:00:00.000Z',
    ...overrides,
  }
}

describe('角色与可写权限', () => {
  test('角色按 initiator / respondent / 其他区分，未登录是 observer', () => {
    expect(disputeRoleOf(dispute(), ME)).toBe('initiator')
    expect(disputeRoleOf(dispute(), PEER)).toBe('respondent')
    expect(disputeRoleOf(dispute(), 'usr_other')).toBe('observer')
    expect(disputeRoleOf(dispute(), null)).toBe('observer')
  })

  test('只有发起人 + PENDING 能撤回/补材料；被诉方全程只读', () => {
    expect(canWithdrawDispute(dispute(), ME)).toBe(true)
    expect(canAddDisputeMaterial(dispute(), ME)).toBe(true)
    expect(canWithdrawDispute(dispute(), PEER)).toBe(false)
    expect(canAddDisputeMaterial(dispute(), PEER)).toBe(false)
    for (const status of ['RESOLVED', 'WITHDRAWN'] as const) {
      expect(canWithdrawDispute(dispute({ status }), ME)).toBe(false)
      expect(canAddDisputeMaterial(dispute({ status }), ME)).toBe(false)
    }
  })
})

describe('30 天发起窗口（与后端 isWindowClosed 同公式）', () => {
  const openTx = { status: 'PENDING_MEETUP' as const, completedAt: null, cancelledAt: null }

  test('PENDING_MEETUP 没有时限；终态从 completedAt ?? cancelledAt 起算', () => {
    expect(disputeWindowClosed(openTx, NOW)).toBe(false)
    const completedAt = '2026-09-20T12:00:00.000Z'
    expect(disputeWindowClosed({ status: 'COMPLETED', completedAt, cancelledAt: null }, NOW)).toBe(
      false,
    )
    expect(
      disputeWindowClosed(
        { status: 'CANCELLED', completedAt: null, cancelledAt: completedAt },
        NOW,
      ),
    ).toBe(false)
  })

  test('刚好 30 天内可发起，超过 1 天才关闭（不提前藏入口）', () => {
    const exactly30 = new Date(NOW - 30 * DAY_MS).toISOString()
    const over30 = new Date(NOW - 30 * DAY_MS - 1).toISOString()
    expect(
      disputeWindowClosed({ status: 'COMPLETED', completedAt: exactly30, cancelledAt: null }, NOW),
    ).toBe(false)
    expect(
      disputeWindowClosed({ status: 'COMPLETED', completedAt: over30, cancelledAt: null }, NOW),
    ).toBe(true)
    // 解析不出来的时间戳不当作「已出窗」，把判断留给服务端（宁可多一个入口也别误伤）
    expect(
      disputeWindowClosed(
        { status: 'COMPLETED', completedAt: 'not-a-date', cancelledAt: null },
        NOW,
      ),
    ).toBe(false)
  })
})

describe('订单详情页的争议入口', () => {
  const openTx = {
    status: 'COMPLETED' as const,
    completedAt: new Date(NOW).toISOString(),
    cancelledAt: null,
  }
  const staleTx = {
    status: 'COMPLETED' as const,
    completedAt: new Date(NOW - 40 * DAY_MS).toISOString(),
    cancelledAt: null,
  }

  test('已有争议时永远可查看，即使已出窗（终态争议也能回看）', () => {
    expect(disputeEntryOf(staleTx, { id: 'dsp_a', status: 'WITHDRAWN' }, NOW)).toEqual({
      kind: 'view',
      dispute: { id: 'dsp_a', status: 'WITHDRAWN' },
    })
  })

  test('撤回过且仍在窗口内：给「重新发起」（后端只对未决去重），窗口外只回看', () => {
    expect(disputeEntryOf(openTx, { id: 'dsp_w', status: 'WITHDRAWN' }, NOW)).toEqual({
      kind: 'refile',
      dispute: { id: 'dsp_w', status: 'WITHDRAWN' },
    })
    // 已处理（RESOLVED）是最终结论，窗口内也不再给重新发起
    expect(disputeEntryOf(openTx, { id: 'dsp_r', status: 'RESOLVED' }, NOW)).toEqual({
      kind: 'view',
      dispute: { id: 'dsp_r', status: 'RESOLVED' },
    })
  })

  test('没有争议时：窗口内可发起，出窗只给 closed 提示', () => {
    expect(disputeEntryOf(openTx, null, NOW)).toEqual({ kind: 'file' })
    expect(disputeEntryOf(staleTx, null, NOW)).toEqual({ kind: 'closed' })
  })

  test('窗口外要给出可读提示（不是静默不显示）：文案来自纯函数，页面只摆版式', () => {
    const closed = disputeEntryCopyOf({ kind: 'closed' })
    expect(closed.off).toBe(true)
    expect(closed.title).toContain('30 天')
    expect(closed.sub).toContain('无法再发起争议')
    const refile = disputeEntryCopyOf({
      kind: 'refile',
      dispute: { id: 'dsp_w', status: 'WITHDRAWN' },
    })
    expect(refile.off).toBe(false)
    expect(refile.act).toBe('重新发起')
  })

  test('同一交易多条争议：优先 PENDING，否则取最新（列表倒序的第一条）', () => {
    const items = [
      { id: 'dsp_new', status: 'RESOLVED' as const, transaction: { id: 'txn_1' } },
      { id: 'dsp_old', status: 'WITHDRAWN' as const, transaction: { id: 'txn_1' } },
      { id: 'dsp_pending', status: 'PENDING' as const, transaction: { id: 'txn_1' } },
      { id: 'dsp_other', status: 'PENDING' as const, transaction: { id: 'txn_2' } },
    ]
    expect(pickDisputeForTransaction(items, 'txn_1')?.id).toBe('dsp_pending')
    expect(
      pickDisputeForTransaction(
        items.filter((item) => item.status !== 'PENDING'),
        'txn_1',
      )?.id,
    ).toBe('dsp_new')
    expect(pickDisputeForTransaction(items, 'txn_404')).toBeNull()
  })
})

describe('附件额度与文案', () => {
  test('额度 = 6 - 已有张数，永不为负；满了直接说清楚而不是让用户点了才 422', () => {
    expect(attachmentSlotsLeft(0)).toBe(6)
    expect(attachmentSlotsLeft(5)).toBe(1)
    expect(attachmentSlotsLeft(6)).toBe(0)
    expect(attachmentSlotsLeft(9)).toBe(0)
    expect(attachmentActionLabel(5)).toBe('补附件')
    expect(attachmentActionLabel(6)).toBe('附件已满（6 张）')
  })
})

describe('契约枚举的文案完整性', () => {
  test('每种类型/状态/结论都有中文标签与 tone', () => {
    expect([...DISPUTE_TYPE_ORDER].sort()).toEqual([...DisputeTypeSchema.options].sort())
    for (const type of DisputeTypeSchema.options) {
      expect(DISPUTE_TYPE_META[type].label.length).toBeGreaterThan(0)
    }
    for (const status of DisputeStatusSchema.options) {
      expect(DISPUTE_STATUS_META[status].label.length).toBeGreaterThan(0)
    }
    for (const resolution of DisputeResolutionSchema.options) {
      expect(DISPUTE_RESOLUTION_META[resolution].label.length).toBeGreaterThan(0)
    }
  })

  test('每个契约错误码都有专属文案；未知码/无码走通用兜底而不是漏出英文码', () => {
    expect(Object.keys(DISPUTE_ERROR_COPY).sort()).toEqual(
      [...DisputeErrorCodeSchema.options].sort(),
    )
    for (const code of DisputeErrorCodeSchema.options) {
      expect(disputeFailureText(code)).not.toBe('操作没成功，请稍后再试')
    }
    expect(disputeFailureText('SOMETHING_ELSE')).toBe('操作没成功，请稍后再试')
    expect(disputeFailureText(null)).toBe('操作没成功，请稍后再试')
  })

  test('NOT_PENDING 在撤回按钮上换一种说法（「不能再补充材料」读着不对）', () => {
    expect(disputeFailureText('DISPUTE_NOT_PENDING')).toBe(DISPUTE_ERROR_COPY.DISPUTE_NOT_PENDING)
    expect(disputeFailureText('DISPUTE_NOT_PENDING', 'withdraw')).toBe(
      DISPUTE_NOT_PENDING_WITHDRAW_COPY,
    )
    expect(DISPUTE_NOT_PENDING_WITHDRAW_COPY).toContain('刷新')
    // scene 只影响这一个码，其余文案两边一致
    expect(disputeFailureText('DISPUTE_NOT_FOUND', 'withdraw')).toBe(
      disputeFailureText('DISPUTE_NOT_FOUND'),
    )
  })
})

describe('列表行映射与短号', () => {
  test('我发起视角的「对方」是被诉方，反之亦然', () => {
    const mine = disputeToRecord(dispute(), ME, NOW)
    expect(mine.roleLabel).toBe('我发起')
    expect(mine.counterpartNickname).toBe('卖家小林')
    expect(mine.statusLabel).toBe('处理中')
    expect(mine.tone).toBe('warn')
    expect(mine.listingTitle).toBe('索尼降噪耳机')
    expect(mine.amountText).toBe('320')

    const theirs = disputeToRecord(dispute(), PEER, NOW)
    expect(theirs.roleLabel).toBe('对方发起')
    expect(theirs.counterpartNickname).toBe('买家小周')
  })

  test('列表行的时间文案按「现在」算，长 ID 截成可对照的短号', () => {
    const record = disputeToRecord(
      dispute({ createdAt: new Date(NOW - 2 * 3_600_000).toISOString() }),
      ME,
      NOW,
    )
    expect(record.timeLabel).toBe('2 小时前')
    expect(shortDisputeId('dsp_01J8ZQ3XK7M2ABCDEFG')).toBe('dsp_01J8Z…DEFG')
    expect(shortDisputeId('dsp_short')).toBe('dsp_short')
  })
})

describe('查不到的文案', () => {
  test('详情 404 与发起页 404 说清不同原因（非参与人 ≠ 系统故障）', () => {
    expect(disputeNotFoundCopy('detail').title).not.toBe(disputeNotFoundCopy('create').title)
    expect(disputeNotFoundCopy('detail').text).toContain('参与人')
    expect(disputeNotFoundCopy('create').text).toContain('交易')
  })
})
