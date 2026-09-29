import { describe, expect, test } from 'bun:test'
import type { ConversationDto } from '@fish/contracts/chat/schema'
import type { TransactionDto } from '@fish/contracts/transactions/schema'
import {
  capsuleFor,
  parseTxSystemEvent,
  transactionsByConversation,
} from '../src/features/chat/capsule'

/**
 * 会话行交易进度胶囊（任务一 #89）。
 *
 * 锁的是状态机本身：交易行的三种 status × 查看者角色、以及「提案不落表」时从
 * lastMessage 的 `tx.proposal` 推导待同意/待接受。组件接线靠 code review（同
 * `chat-list-view.test.ts` 的口径）。
 */

const PROPOSAL_CONTENT = JSON.stringify({ type: 'tx.proposal', amountCents: 15000 })

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

  test('闲聊 TEXT 盖过旧提议、SYSTEM 内容解析失败 → 不显示（不猜）', () => {
    expect(
      capsuleFor(
        dto({
          lastMessage: {
            type: 'TEXT',
            content: '在吗',
            senderId: 'u-1',
            createdAt: '2026-09-21T03:40:00.000Z',
          },
        }),
        new Map(),
      ),
    ).toBeNull()
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
  })

  test('无交易也无提议 → 不显示胶囊', () => {
    expect(capsuleFor(dto(), new Map())).toBeNull()
  })
})

describe('parseTxSystemEvent / transactionsByConversation', () => {
  test('解析合法 tx.* 内容，拒绝未知形状', () => {
    expect(parseTxSystemEvent(PROPOSAL_CONTENT)).toEqual({
      type: 'tx.proposal',
      amountCents: 15000,
    })
    expect(parseTxSystemEvent(JSON.stringify({ type: 'tx.mystery' }))).toBeNull()
    expect(parseTxSystemEvent('纯文本')).toBeNull()
  })

  test('买卖两个角色的列表按 conversationId 合成一张映射', () => {
    const map = transactionsByConversation(
      [tx({ id: 't-1', conversationId: 'c-1' })],
      [tx({ id: 't-2', conversationId: 'c-2', role: 'seller' })],
    )
    expect(map.get('c-1')?.id).toBe('t-1')
    expect(map.get('c-2')?.id).toBe('t-2')
    expect(map.size).toBe(2)
  })
})
