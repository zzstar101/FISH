import { describe, expect, test } from 'bun:test'
import type { ConversationDto, MessageDto } from '@fish/contracts/chat/schema'
import type { TransactionDto } from '@fish/contracts/transactions/schema'
import {
  capsuleFor,
  currentTxOf,
  lastEventOfMessages,
  needsProposalScan,
  transactionsByConversation,
} from '../src/features/chat/capsule'

/**
 * 会话行交易进度胶囊（任务一 #89）。
 *
 * 锁的是状态机本身：交易行的三种 status × 查看者角色、以及「提案不落表」时从
 * 最后一个交易事件推导待同意/待接受。组件接线靠 code review（同
 * `chat-list-view.test.ts` 的口径）。
 */

const PROPOSAL_CONTENT = JSON.stringify({ type: 'tx.proposal', amountCents: 15000 })

function systemMessage(content: string, createdAt = '2026-09-21T03:30:00.000Z'): MessageDto {
  return {
    id: `m-${content.length}-${createdAt}`,
    conversationId: 'c-1',
    senderId: null,
    sender: null,
    type: 'SYSTEM',
    content,
    createdAt,
  }
}

function textMessage(content: string, createdAt = '2026-09-21T03:40:00.000Z'): MessageDto {
  return {
    id: `m-t-${content}`,
    conversationId: 'c-1',
    senderId: 'u-2',
    sender: null,
    type: 'TEXT',
    content,
    createdAt,
  }
}

function dto(overrides: Partial<ConversationDto> = {}): ConversationDto {
  return {
    id: 'c-1',
    listingId: 'l-1',
    role: 'buyer',
    listing: {
      id: 'l-1',
      title: 'K380 键盘',
      priceCents: 16000,
      status: 'ACTIVE',
      coverUrl: null,
    },
    counterpart: { id: 'u-2', nickname: '卖家', avatarUrl: null },
    unreadCount: 0,
    counterpartLastReadAt: null,
    lastMessage: null,
    lastMessageAt: '2026-09-21T04:00:00.000Z',
    createdAt: '2026-09-21T03:00:00.000Z',
    ...overrides,
  }
}

function tx(overrides: Partial<TransactionDto> = {}): TransactionDto {
  return {
    id: 't-1',
    conversationId: 'c-1',
    listingId: 'l-1',
    buyerId: 'u-1',
    sellerId: 'u-2',
    role: 'buyer',
    listing: {
      id: 'l-1',
      title: 'K380 键盘',
      priceCents: 15000,
      status: 'RESERVED',
      coverUrl: null,
    },
    counterpart: { id: 'u-2', nickname: '卖家', avatarUrl: null },
    amountCents: 15000,
    status: 'PENDING_MEETUP',
    buyerConfirmedAt: null,
    sellerConfirmedAt: null,
    completedAt: null,
    cancelledAt: null,
    createdAt: '2026-09-21T03:30:00.000Z',
    updatedAt: '2026-09-21T03:30:00.000Z',
    ...overrides,
  }
}

describe('capsuleFor —— 交易行状态', () => {
  test('PENDING_MEETUP 且我方未确认 → 待面交（黄）', () => {
    const capsule = capsuleFor(dto(), new Map([['c-1', tx()]]))
    expect(capsule).toEqual({ label: '待面交', cls: 'is-warn' })
  })

  test('PENDING_MEETUP 且我方已确认（卖家视角同理）→ 待对方确认（蓝）', () => {
    const mine = capsuleFor(
      dto(),
      new Map([['c-1', tx({ buyerConfirmedAt: '2026-09-21T05:00:00.000Z' })]]),
    )
    expect(mine).toEqual({ label: '待对方确认', cls: 'is-pending' })

    const sellerView = capsuleFor(
      dto({ role: 'seller' }),
      new Map([['c-1', tx({ role: 'seller', sellerConfirmedAt: '2026-09-21T05:00:00.000Z' })]]),
    )
    expect(sellerView).toEqual({ label: '待对方确认', cls: 'is-pending' })
  })

  // Owner 2026-09-29 端上定版：完成走绿、取消走浅底灰；两条都不许回退成订单页那套
  // 深色实心胶囊（`is-done` / `is-cancel` 是 `status-pill` 的档名，本页不用）。
  test('COMPLETED → 已完成（绿）；CANCELLED → 已取消（浅底灰）', () => {
    expect(capsuleFor(dto(), new Map([['c-1', tx({ status: 'COMPLETED' })]]))).toEqual({
      label: '已完成',
      cls: 'is-ok',
    })
    expect(capsuleFor(dto(), new Map([['c-1', tx({ status: 'CANCELLED' })]]))).toEqual({
      label: '已取消',
      cls: 'is-plain',
    })
  })

  test('未终结的交易行优先于 lastMessage / 扫描结果（接受后成交前的提案消息不改状态）', () => {
    const conversation = dto({
      lastMessage: {
        type: 'SYSTEM',
        content: PROPOSAL_CONTENT,
        senderId: null,
        createdAt: '2026-09-21T03:30:00.000Z',
      },
    })
    // accepted 之后那条提案消息还在会话里，但它已是历史：状态由交易行说了算。
    expect(capsuleFor(conversation, new Map([['c-1', tx({ status: 'PENDING_MEETUP' })]]))).toEqual({
      label: '待面交',
      cls: 'is-warn',
    })
    expect(
      capsuleFor(
        conversation,
        new Map([['c-1', tx({ status: 'COMPLETED' })]]),
        new Map([['c-1', { type: 'tx.proposal', amountCents: 15000 }]]),
      ),
    ).toEqual({ label: '已完成', cls: 'is-ok' })
  })

  /*
   * 取消后重新提案：`cancel` 把 listing 放回 ACTIVE，买家可以再提一次案（提案只写
   * SYSTEM 消息、不落表），于是「旧行 CANCELLED + 新提案在等点头」同时存在。
   * 只认交易行会把「等你接受」显示成「已取消」，卖家明明要动手却看到终态。
   * 终态不产生 SYSTEM 消息（契约 `transactionSystemEventSchema` 只有三元），所以
   * 行已取消时「最后一个交易事件是提案」必然来自取消之后。
   */
  test('已取消的行被之后的提案盖过 → 回到待同意/待接受', () => {
    const cancelled = new Map([
      ['c-1', tx({ status: 'CANCELLED', cancelledAt: '2026-09-21T04:00:00.000Z' })],
    ])
    const scanned = new Map([['c-1', { type: 'tx.proposal' as const, amountCents: 16000 }]])

    expect(capsuleFor(dto(), cancelled, scanned)).toEqual({ label: '待同意', cls: 'is-pending' })
    expect(capsuleFor(dto({ role: 'seller' }), cancelled, scanned)).toEqual({
      label: '待接受',
      cls: 'is-pending',
    })
    // 扫过、确认取消之后没有新提案 → 仍是已取消
    expect(capsuleFor(dto(), cancelled, new Map([['c-1', null]]))).toEqual({
      label: '已取消',
      cls: 'is-plain',
    })
  })

  test('已取消 + 老 accepted（无 id）→ 仍是已取消，不能退回待同意', () => {
    const cancelled = new Map([
      ['c-1', tx({ status: 'CANCELLED', cancelledAt: '2026-09-21T04:00:00.000Z' })],
    ])
    const scanned = new Map([['c-1', { type: 'tx.accepted' as const, amountCents: 15000 }]])
    expect(capsuleFor(dto(), cancelled, scanned)).toEqual({ label: '已取消', cls: 'is-plain' })
  })
})

describe('capsuleFor —— 提案阶段（不落 transactions 表）', () => {
  test('买家已发提议且是最后一条 SYSTEM 消息 → 买家看到待同意（蓝）', () => {
    const conversation = dto({
      lastMessage: {
        type: 'SYSTEM',
        content: PROPOSAL_CONTENT,
        senderId: null,
        createdAt: '2026-09-21T03:30:00.000Z',
      },
    })
    expect(capsuleFor(conversation, new Map())).toEqual({ label: '待同意', cls: 'is-pending' })
  })

  test('同一提议，卖家视角是待接受（蓝）', () => {
    const conversation = dto({
      role: 'seller',
      lastMessage: {
        type: 'SYSTEM',
        content: PROPOSAL_CONTENT,
        senderId: null,
        createdAt: '2026-09-21T03:30:00.000Z',
      },
    })
    expect(capsuleFor(conversation, new Map())).toEqual({ label: '待接受', cls: 'is-pending' })
  })

  /*
   * 关键回归：买家提了案、之后有人回了句闲聊 —— 提案仍在等点头，胶囊不能消失。
   * 只看 `lastMessage`（TEXT）会得出「没有交易意向」的错误结论，所以页面会为这类
   * 会话补拉一页消息，把最后一个交易事件交给 `capsuleFor`。
   */
  test('提案之后有人发 TEXT → 用扫描结果仍然显示待同意/待接受', () => {
    const conversation = dto({
      lastMessage: {
        type: 'TEXT',
        content: '在吗',
        senderId: 'u-2',
        createdAt: '2026-09-21T03:40:00.000Z',
      },
    })
    const scanned = new Map([['c-1', { type: 'tx.proposal' as const, amountCents: 15000 }]])
    expect(capsuleFor(conversation, new Map(), scanned)).toEqual({
      label: '待同意',
      cls: 'is-pending',
    })

    const sellerView = capsuleFor(dto({ role: 'seller' }), new Map(), scanned)
    expect(sellerView).toEqual({ label: '待接受', cls: 'is-pending' })
  })

  test('扫过且确实没有交易事件（索引里是 null）→ 不显示胶囊', () => {
    const conversation = dto({
      lastMessage: {
        type: 'TEXT',
        content: '在吗',
        senderId: 'u-2',
        createdAt: '2026-09-21T03:40:00.000Z',
      },
    })
    expect(capsuleFor(conversation, new Map(), new Map([['c-1', null]]))).toBeNull()
  })

  test('提议被拒绝（tx.rejected）→ 不显示胶囊，不给死状态', () => {
    const conversation = dto({
      lastMessage: {
        type: 'SYSTEM',
        content: JSON.stringify({ type: 'tx.rejected' }),
        senderId: null,
        createdAt: '2026-09-21T03:30:00.000Z',
      },
    })
    expect(capsuleFor(conversation, new Map())).toBeNull()
  })

  test('SYSTEM 内容解析失败、无交易也无提议 → 不显示（不猜）', () => {
    expect(
      capsuleFor(
        dto({
          lastMessage: {
            type: 'SYSTEM',
            content: '{ 不是 JSON',
            senderId: null,
            createdAt: '2026-09-21T03:30:00.000Z',
          },
        }),
        new Map(),
      ),
    ).toBeNull()
    expect(capsuleFor(dto(), new Map())).toBeNull()
  })
})

describe('needsProposalScan —— 哪些行要补拉消息页', () => {
  test('有交易行 / lastMessage 已是 tx.* / 空会话 → 都不用扫', () => {
    expect(
      needsProposalScan(
        dto({
          lastMessage: {
            type: 'TEXT',
            content: '在吗',
            senderId: 'u-2',
            createdAt: '2026-09-21T03:40:00.000Z',
          },
        }),
        new Map([['c-1', tx()]]),
      ),
    ).toBe(false)
    const proposalLast = dto({
      lastMessage: {
        type: 'SYSTEM',
        content: PROPOSAL_CONTENT,
        senderId: null,
        createdAt: '2026-09-21T03:30:00.000Z',
      },
    })
    expect(needsProposalScan(proposalLast, new Map())).toBe(false)
    expect(needsProposalScan(dto(), new Map())).toBe(false)
  })

  /*
   * 已取消是唯一「行存在也仍要扫」的状态：取消把 listing 放回 ACTIVE，同一会话可以
   * 重新提案（见 `capsuleFor` 的用例）。COMPLETED / PENDING_MEETUP 下 `propose`
   * 必 409（SOLD / RESERVED），扫了也只是白发请求。
   */
  test('已取消的交易行仍要扫（取消后可能重新提案）；完成 / 待面交不用扫', () => {
    const textLast = dto({
      lastMessage: {
        type: 'TEXT',
        content: '在吗',
        senderId: 'u-2',
        createdAt: '2026-09-21T03:40:00.000Z',
      },
    })
    expect(needsProposalScan(textLast, new Map([['c-1', tx({ status: 'CANCELLED' })]]))).toBe(true)
    expect(needsProposalScan(textLast, new Map([['c-1', tx({ status: 'COMPLETED' })]]))).toBe(false)
    expect(needsProposalScan(textLast, new Map([['c-1', tx({ status: 'PENDING_MEETUP' })]]))).toBe(
      false,
    )
  })

  test('没有交易行且 lastMessage 是 TEXT / 非交易 SYSTEM → 要扫', () => {
    const textLast = dto({
      lastMessage: {
        type: 'TEXT',
        content: '在吗',
        senderId: 'u-2',
        createdAt: '2026-09-21T03:40:00.000Z',
      },
    })
    expect(needsProposalScan(textLast, new Map())).toBe(true)

    const otherSystem = dto({
      lastMessage: {
        type: 'SYSTEM',
        content: '你的学号认证已通过',
        senderId: null,
        createdAt: '2026-09-21T03:40:00.000Z',
      },
    })
    expect(needsProposalScan(otherSystem, new Map())).toBe(true)
  })
})

describe('lastEventOfMessages —— 取最后一个交易事件，不是最后一条消息', () => {
  test('提案之后压着 TEXT → 仍是提案', () => {
    expect(lastEventOfMessages([systemMessage(PROPOSAL_CONTENT), textMessage('包邮吗？')])).toEqual(
      {
        type: 'tx.proposal',
        amountCents: 15000,
      },
    )
  })

  test('提案 → 接受 → 闲聊 → 仍是接受（下一个事件才是新状态）', () => {
    const accepted = JSON.stringify({
      type: 'tx.accepted',
      transactionId: 'txn_01jc001qkte00800000000fjta',
      amountCents: 15000,
    })
    expect(
      lastEventOfMessages([
        systemMessage(PROPOSAL_CONTENT),
        systemMessage(accepted, '2026-09-21T03:35:00.000Z'),
        textMessage('明天见', '2026-09-21T03:50:00.000Z'),
      ]),
    ).toEqual({
      type: 'tx.accepted',
      transactionId: 'txn_01jc001qkte00800000000fjta',
      amountCents: 15000,
    })
  })

  test('只有闲聊 / 非交易系统消息 → null（确实没有交易事件）', () => {
    expect(
      lastEventOfMessages([systemMessage('你的学号认证已通过'), textMessage('在吗')]),
    ).toBeNull()
  })

  /*
   * 老数据的 accepted 没有 `transactionId`（#521 明确要求兼容）。契约 schema 把它判为
   * 非法，读路径若跟着严格解析，最后一个事件会退回更早的 proposal —— 已取消的行就会
   * 显示成「待同意」，与预览的「交易已取消」自相矛盾。
   */
  test('缺 transactionId 的老 accepted 仍然算事件（不能被严格 schema 丢掉）', () => {
    expect(
      lastEventOfMessages([
        systemMessage(PROPOSAL_CONTENT),
        systemMessage(JSON.stringify({ type: 'tx.accepted', amountCents: 15000 })),
      ]),
    ).toEqual({ type: 'tx.accepted', amountCents: 15000 })
  })
})

describe('transactionsByConversation', () => {
  test('买卖两个角色的列表按 conversationId 合成一张映射', () => {
    const map = transactionsByConversation(
      [tx({ id: 't-1', conversationId: 'c-1' })],
      [tx({ id: 't-2', conversationId: 'c-2', role: 'seller' })],
    )
    expect(map.get('c-1')?.id).toBe('t-1')
    expect(map.get('c-2')?.id).toBe('t-2')
    expect(map.size).toBe(2)
  })

  /*
   * 取消后重新接受会在同一会话下再建一笔交易（`transactions` 的部分唯一索引只约束
   * PENDING_MEETUP / COMPLETED，CANCELLED 行可累积）。列表按 `created_at DESC` 返回，
   * 无脑覆盖会让最旧那笔（早已取消的）永久盖住当前那笔 —— 胶囊会一直显示「已取消」。
   */
  test('同一会话多笔交易时取最新那笔（列表里旧的排在后面）', () => {
    const older = tx({
      id: 't-old',
      conversationId: 'c-1',
      status: 'CANCELLED',
      cancelledAt: '2026-09-20T00:00:00.000Z',
      createdAt: '2026-09-19T00:00:00.000Z',
    })
    const newer = tx({ id: 't-new', conversationId: 'c-1', createdAt: '2026-09-21T00:00:00.000Z' })
    // 服务端 ORDER BY created_at DESC：新的在前、旧的在后
    const map = transactionsByConversation([newer, older], [])
    expect(map.get('c-1')?.id).toBe('t-new')
    expect(capsuleFor(dto(), map)).toEqual({ label: '待面交', cls: 'is-warn' })
  })

  test('createdAt 相同毫秒时保留列表里更靠前的那笔（DESC = 更新）', () => {
    const sameMs = '2026-09-21T00:00:00.000Z'
    const newer = tx({ id: 't-new', conversationId: 'c-1', createdAt: sameMs })
    const older = tx({
      id: 't-old',
      conversationId: 'c-1',
      status: 'CANCELLED',
      cancelledAt: '2026-09-20T00:00:00.000Z',
      createdAt: sameMs,
    })
    const map = transactionsByConversation([newer, older], [])
    expect(map.get('c-1')?.id).toBe('t-new')
  })
})

/**
 * 同一会话多笔历史交易的 latest-wins 判据（#613 验收口径：进度块只反映最新那笔，
 * **不许分叉出第三套判定**）。这条判据原本在 `capsuleFor` 与 `view.ts` 的 `txBarView`
 * 各写一份，`txStageView` 落地时又抄了第三份 —— 这里把它钉成**唯一一份**导出，
 * 三个调用方共用，改判据只改一处。
 */
describe('currentTxOf —— 「取消后又被新提案盖过」的唯一一份判据', () => {
  test('已取消的行 + 最后一条事件是提案 → 行被盖过（null），改按提案陈述', () => {
    expect(currentTxOf(tx({ status: 'CANCELLED' }), 'tx.proposal')).toBeNull()
  })

  test('已取消的行 + 最后一条事件不是提案（拒绝 / 接受 / 空）→ 行仍然有效', () => {
    const cancelled = tx({ status: 'CANCELLED' })
    expect(currentTxOf(cancelled, 'tx.rejected')).toBe(cancelled)
    expect(currentTxOf(cancelled, 'tx.accepted')).toBe(cancelled)
    expect(currentTxOf(cancelled, null)).toBe(cancelled)
  })

  test('只有 CANCELLED 会被盖过：进行中 / 已完成的行不适用（listing 被锁，提不出新案）', () => {
    const pending = tx({ status: 'PENDING_MEETUP' })
    const completed = tx({ status: 'COMPLETED' })
    expect(currentTxOf(pending, 'tx.proposal')).toBe(pending)
    expect(currentTxOf(completed, 'tx.proposal')).toBe(completed)
  })

  test('没有交易行就是没有（提案态由调用方自己看 lastEvent.type）', () => {
    expect(currentTxOf(null, 'tx.proposal')).toBeNull()
    expect(currentTxOf(null, null)).toBeNull()
  })
})
