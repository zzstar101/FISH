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
  disputeSecondaryOf,
  disputeWindowClosed,
  evidenceMessageText,
  keepDetailOnSilentFailure,
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
  const pendingRef = { id: 'dsp_p', status: 'PENDING' as const }
  const withdrawnRef = { id: 'dsp_w', status: 'WITHDRAWN' as const }
  const resolvedRef = { id: 'dsp_r', status: 'RESOLVED' as const }

  // 矩阵来自后端语义：唯一索引只拦「同一发起人同交易的第二条 PENDING」，终态不占约束，
  // 所以「被驳回 / 撤回后窗口内可重新发起」成立，对方有争议也不阻断本人发起。
  test('① 本人有 PENDING → 查看（撤回/补材料都在详情里）', () => {
    expect(disputeEntryOf(openTx, { mine: pendingRef, other: null }, NOW)).toEqual({
      kind: 'view',
      dispute: pendingRef,
    })
    // 对方也有未决时不改变主入口
    expect(disputeEntryOf(openTx, { mine: pendingRef, other: resolvedRef }, NOW)).toEqual({
      kind: 'view',
      dispute: pendingRef,
    })
  })

  test('② 本人无 PENDING + 窗口开放 → 发起；对方有未决也不阻断本人发起', () => {
    expect(disputeEntryOf(openTx, { mine: null, other: pendingRef }, NOW)).toEqual({
      kind: 'file',
      refileFrom: null,
      other: pendingRef,
    })
    expect(disputeEntryOf(openTx, null, NOW)).toEqual({
      kind: 'file',
      refileFrom: null,
      other: null,
    })
  })

  test('③ 窗口关闭 + 有可见争议 → 只回看（优先本人那条）', () => {
    expect(disputeEntryOf(staleTx, { mine: null, other: resolvedRef }, NOW)).toEqual({
      kind: 'view',
      dispute: resolvedRef,
    })
    expect(disputeEntryOf(staleTx, { mine: withdrawnRef, other: resolvedRef }, NOW)).toEqual({
      kind: 'view',
      dispute: withdrawnRef,
    })
  })

  test('③ 窗口关闭 + 无可见争议 → closed 只读提示（不是静默不显示）', () => {
    expect(disputeEntryOf(staleTx, null, NOW)).toEqual({ kind: 'closed' })
    expect(disputeEntryOf(staleTx, { mine: null, other: null }, NOW)).toEqual({ kind: 'closed' })
  })

  test('④ 本人仅有终态争议 + 窗口开放 → 可重新发起，refileFrom 指向那条（后端允许终态后再发起）', () => {
    expect(disputeEntryOf(openTx, { mine: withdrawnRef, other: null }, NOW)).toEqual({
      kind: 'file',
      refileFrom: withdrawnRef,
      other: null,
    })
    // RESOLVED 也是终态、同样不占唯一索引，窗口内可以再发起（与 #465 的 30 天门禁一致）
    expect(disputeEntryOf(openTx, { mine: resolvedRef, other: null }, NOW)).toEqual({
      kind: 'file',
      refileFrom: resolvedRef,
      other: null,
    })
  })

  test('「发起」旁边的次要入口：优先本人那条，其次对方那条；查看/只读形态没有次要入口', () => {
    expect(
      disputeSecondaryOf(disputeEntryOf(openTx, { mine: resolvedRef, other: pendingRef }, NOW)),
    ).toEqual({ dispute: resolvedRef, label: '查看这条争议' })
    expect(
      disputeSecondaryOf(disputeEntryOf(openTx, { mine: null, other: pendingRef }, NOW)),
    ).toEqual({ dispute: pendingRef, label: '查看对方争议' })
    expect(disputeSecondaryOf({ kind: 'view', dispute: pendingRef })).toBeNull()
    expect(disputeSecondaryOf({ kind: 'closed' })).toBeNull()
  })

  test('入口卡文案：普通发起 / 重新发起 / 窗口外只读提示', () => {
    expect(disputeEntryCopyOf({ kind: 'file', refileFrom: null, other: null }).act).toBe('发起争议')
    const refile = disputeEntryCopyOf({ kind: 'file', refileFrom: resolvedRef, other: null })
    expect(refile.off).toBe(false)
    expect(refile.act).toBe('重新发起')
    expect(refile.sub).toContain('重新发起')

    const closed = disputeEntryCopyOf({ kind: 'closed' })
    expect(closed.off).toBe(true)
    expect(closed.title).toContain('30 天')
    expect(closed.sub).toContain('无法再发起争议')
  })

  test('后台过期的交易快照不能沿用旧判定：PENDING_MEETUP → 完成超 30 天 = closed', () => {
    const before = { status: 'PENDING_MEETUP' as const, completedAt: null, cancelledAt: null }
    const after = {
      status: 'COMPLETED' as const,
      completedAt: new Date(NOW - 40 * DAY_MS).toISOString(),
      cancelledAt: null,
    }
    expect(disputeEntryOf(before, null, NOW)).toEqual({
      kind: 'file',
      refileFrom: null,
      other: null,
    })
    expect(disputeEntryOf(after, null, NOW)).toEqual({ kind: 'closed' })
  })
})

describe('证据正文', () => {
  test('撤回的消息只显示撤回碑（服务端撤回后仍可能保留原文，不能把正文再摆出来）', () => {
    expect(evidenceMessageText({ content: '转账记录在下面', recalledAt: null })).toBe(
      '转账记录在下面',
    )
    expect(
      evidenceMessageText({ content: '转账记录在下面', recalledAt: '2026-10-03T02:00:00.000Z' }),
    ).toBe('消息已撤回')
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
  // tone 是视觉语义（warn=处理中 / ok=最终结论为真 / off=已结束或驳回）：
  // 拼错 tone 不会在 typecheck 里响（它只是字符串字面量），只会让胶囊颜色悄悄错，所以钉死。
  const EXPECTED_STATUS_TONE = { PENDING: 'warn', RESOLVED: 'ok', WITHDRAWN: 'off' } as const
  const EXPECTED_RESOLUTION_TONE = { UPHELD: 'ok', DISMISSED: 'off', INCONCLUSIVE: 'warn' } as const

  test('每种类型/状态/结论都有中文标签与 tone', () => {
    expect([...DISPUTE_TYPE_ORDER].sort()).toEqual([...DisputeTypeSchema.options].sort())
    for (const type of DisputeTypeSchema.options) {
      expect(DISPUTE_TYPE_META[type].label.length).toBeGreaterThan(0)
    }
    for (const status of DisputeStatusSchema.options) {
      expect(DISPUTE_STATUS_META[status].label.length).toBeGreaterThan(0)
      expect(DISPUTE_STATUS_META[status].tone).toBe(EXPECTED_STATUS_TONE[status])
    }
    for (const resolution of DisputeResolutionSchema.options) {
      expect(DISPUTE_RESOLUTION_META[resolution].label.length).toBeGreaterThan(0)
      expect(DISPUTE_RESOLUTION_META[resolution].tone).toBe(EXPECTED_RESOLUTION_TONE[resolution])
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
    expect(theirs.roleLabel).toBe('我被诉')
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

describe('静默刷新失败', () => {
  test('手上已有详情时保留内容：断网不该把能看的详情页换成错误屏', () => {
    expect(keepDetailOnSilentFailure(true, true)).toBe(true)
    expect(keepDetailOnSilentFailure(true, false)).toBe(false)
    // 非静默（首次进入 / 用户点重试）照常落错误态
    expect(keepDetailOnSilentFailure(false, true)).toBe(false)
    expect(keepDetailOnSilentFailure(false, false)).toBe(false)
  })
})
