import { describe, expect, test } from 'bun:test'
import type { ConversationDto, MessageDto } from '@fish/contracts/chat/schema'
import type { TransactionDto } from '@fish/contracts/transactions/schema'
import {
  capsuleFor,
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

  test('交易行存在时优先于 lastMessage 的提案（接受后成交前闲聊不改状态）', () => {
    const conversation = dto({
      lastMessage: {
        type: 'SYSTEM',
        content: PROPOSAL_CONTENT,
        senderId: null,
        createdAt: '2026-09-21T03:30:00.000Z',
      },
    })
    expect(capsuleFor(conversation, new Map([['c-1', tx({ status: 'CANCELLED' })]]))).toEqual({
      label: '已取消',
      cls: 'is-plain',
    })
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
})
