import { describe, expect, test } from 'bun:test'
import type { TransactionDto } from '@fish/contracts/transactions/schema'
import { txStageView } from '../src/pkg-social/pages/conversation/view'

/**
 * 会话区交易进度块（#613）：阶段胶囊 + 交易气泡。
 *
 * 这里锁的是**界面说什么、能点出什么动作**：五档阶段（提案待确认 / 待面交 / 成交 /
 * 已评价 / 终态）的胶囊与气泡标题、以及动作语义（必须与顶部状态条同一套 `TxBarAction`，
 * 页面才复用同一个 `runTxBarAction` 去执行）。
 *
 * 胶囊口径（Owner 2026-11-04 定案）：提案 / 接受 / 拒绝三档的说法由流里那条 SYSTEM 灰胶囊
 * 承担（`systemPillText`，测试在 `conversation-view.test.ts`），本块只补气泡；只有终态
 * （成交 / 评价完成）没有系统消息可承载，才由本块出胶囊；已取消档整块不出（顶部状态条独占）。
 * 样式与布局靠真机演示。
 */

function tx(overrides: Partial<TransactionDto> = {}): TransactionDto {
  return {
    id: 'txn_1',
    conversationId: 'c-1',
    listingId: 'l-1',
    buyerId: 'u-1',
    sellerId: 'u-2',
    role: 'buyer',
    listing: {
      id: 'l-1',
      title: 'K380 键盘',
      priceCents: 18000,
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

/** 默认入参：没有交易也没有提案；每个用例只覆盖自己关心的字段 */
function input(overrides: Partial<Parameters<typeof txStageView>[0]> = {}) {
  return {
    role: 'buyer' as const,
    listingStatus: 'ACTIVE',
    listing: { title: 'K380 键盘', coverUrl: 'https://cdn.example.com/l-1.jpg' },
    tx: null,
    lastEvent: null,
    reviewed: null,
    failed: false,
    ...overrides,
  }
}

describe('txStageView —— ① 拍下待确认（还没有交易行）', () => {
  test('卖家：胶囊留空（灰胶囊在说「商品被拍下，前往确认」），气泡里「确认 / 拒绝」上下两颗，金额取自提案消息', () => {
    const view = txStageView(
      input({ role: 'seller', lastEvent: { type: 'tx.proposal', amountCents: 12000 } }),
    )
    expect(view).not.toBeNull()
    expect(view?.capsule).toBeNull()
    expect(view?.bubble).toMatchObject({
      title: '买家已拍下，待我确认',
      listingTitle: 'K380 键盘',
      coverUrl: 'https://cdn.example.com/l-1.jpg',
      amountCents: 12000,
      actions: [
        { label: '确认', variant: 'primary', action: { kind: 'confirm', amountCents: 12000 } },
        { label: '拒绝', variant: 'ghost', action: { kind: 'reject' } },
      ],
    })
  })

  test('买家：气泡只说事实，没有任何动作（拒绝是卖家侧的事）', () => {
    const view = txStageView(input({ lastEvent: { type: 'tx.proposal', amountCents: 12000 } }))
    expect(view?.capsule).toBeNull()
    expect(view?.bubble).toMatchObject({ title: '我已拍下，待卖家确认', amountCents: 12000 })
    expect(view?.bubble?.actions).toEqual([])
  })

  test('提案没带金额：气泡照出，但不凭空造一个价格（确认钮也不带金额）', () => {
    const view = txStageView(input({ role: 'seller', lastEvent: { type: 'tx.proposal' } }))
    expect(view?.bubble?.amountCents).toBeNull()
    expect(view?.bubble?.actions[0]).toEqual({
      label: '确认',
      variant: 'primary',
      action: { kind: 'confirm', amountCents: null },
    })
  })

  test('提案还在、商品却不是 ACTIVE：整块不出（不给必然 409 的「确认」）', () => {
    expect(
      txStageView(
        input({
          role: 'seller',
          listingStatus: 'SOLD',
          lastEvent: { type: 'tx.proposal', amountCents: 12000 },
        }),
      ),
    ).toBeNull()
    expect(
      txStageView(
        input({ role: 'seller', listingStatus: undefined, lastEvent: { type: 'tx.proposal' } }),
      ),
    ).toBeNull()
  })
})

describe('txStageView —— ② 被拒绝：交给灰胶囊，这块不出', () => {
  test('被拒绝：整块不渲染（「交易被拒绝」由那条 tx.rejected 的 SYSTEM 灰胶囊说）', () => {
    expect(txStageView(input({ lastEvent: { type: 'tx.rejected' } }))).toBeNull()
    expect(txStageView(input({ role: 'seller', lastEvent: { type: 'tx.rejected' } }))).toBeNull()
  })

  test('取消后又来了新提案：以提案为准，不把「待接受」说成「已取消」', () => {
    const view = txStageView(
      input({
        tx: tx({ status: 'CANCELLED' }),
        lastEvent: { type: 'tx.proposal', amountCents: 9000 },
      }),
    )
    expect(view?.capsule).toBeNull()
    expect(view?.bubble?.amountCents).toBe(9000)
  })

  test('取消后又提新案、新案被拒：整块不出（不要硬掰成新的提案态；顶部状态条已经在说「交易已取消」）', () => {
    expect(
      txStageView(input({ tx: tx({ status: 'CANCELLED' }), lastEvent: { type: 'tx.rejected' } })),
    ).toBeNull()
  })
})

describe('txStageView —— ③ 已接受、待面交', () => {
  test('胶囊留空（灰胶囊说「已接受交易，待面交」）、气泡没有大标题（不把「待面交」说第二遍）；卖家出示码、买家同一颗钮去扫码', () => {
    const seller = txStageView(input({ role: 'seller', tx: tx({ status: 'PENDING_MEETUP' }) }))
    const buyer = txStageView(input({ role: 'buyer', tx: tx({ status: 'PENDING_MEETUP' }) }))
    expect(seller?.capsule).toBeNull()
    expect(buyer?.capsule).toBeNull()
    expect(seller?.bubble?.title).toBeNull()
    expect(buyer?.bubble?.title).toBeNull()
    // 成交价取交易行（15000），不是挂价（18000）
    expect(seller?.bubble?.amountCents).toBe(15000)
    expect(seller?.bubble?.actions).toEqual([
      { label: '打开交易码', variant: 'primary', action: { kind: 'code', transactionId: 'txn_1' } },
    ])
    expect(buyer?.bubble?.actions).toEqual([
      { label: '打开交易码', variant: 'primary', action: { kind: 'scan' } },
    ])
  })
})

describe('txStageView —— ④ 交易成功：评价三态（与顶部状态条同口径）', () => {
  test('还没评价：胶囊「交易成功」，气泡「给对方评价 → 前往评价」进面交页', () => {
    const view = txStageView(input({ tx: tx({ status: 'COMPLETED' }), reviewed: false }))
    expect(view?.capsule).toEqual({ label: '交易成功', tone: 'is-ok' })
    expect(view?.bubble).toMatchObject({ title: '给对方评价' })
    expect(view?.bubble?.actions).toEqual([
      {
        label: '前往评价',
        variant: 'primary',
        action: { kind: 'review', transactionId: 'txn_1' },
      },
    ])
  })

  test('已经评过：胶囊升到终态「交易全流程完成」，气泡「前往查看评价」进我的评价', () => {
    const view = txStageView(input({ tx: tx({ status: 'COMPLETED' }), reviewed: true }))
    expect(view?.capsule).toEqual({ label: '交易全流程完成', tone: 'is-ok' })
    expect(view?.bubble).toMatchObject({ title: '评价已完成' })
    expect(view?.bubble?.actions).toEqual([
      { label: '前往查看评价', variant: 'primary', action: { kind: 'reviews' } },
    ])
  })

  test('评价态没查到（reviewed === null）不虚报「待评价」：标题留空（胶囊已说「交易成功」），目的地仍是面交页', () => {
    const view = txStageView(input({ tx: tx({ status: 'COMPLETED' }), reviewed: null }))
    expect(view?.capsule?.label).toBe('交易成功')
    expect(view?.bubble?.title).toBeNull()
    expect(view?.bubble?.actions[0]).toEqual({
      label: '查看交易',
      variant: 'primary',
      action: { kind: 'review', transactionId: 'txn_1' },
    })
  })
})

describe('txStageView —— ⑤ 不该出现的时候别出现', () => {
  test('没有交易、也没有提案 / 拒绝：整块不渲染', () => {
    expect(txStageView(input())).toBeNull()
    // 认不出的 SYSTEM 事件（普通文本）不算交易进度
    expect(txStageView(input({ lastEvent: { type: 'tx.accepted' } }))).toBeNull()
  })

  test('交易查询失败：整块不出（顶部状态条已经在说「状态待更新 · 重新加载」）', () => {
    expect(
      txStageView(input({ tx: tx({ status: 'COMPLETED' }), reviewed: false, failed: true })),
    ).toBeNull()
    // 失败时连「提案」也不猜：交易行可能是别的交易的缓存
    expect(
      txStageView(input({ failed: true, lastEvent: { type: 'tx.proposal', amountCents: 12000 } })),
    ).toBeNull()
  })

  test('已取消（且没有新提案）：整块不出（顶部状态条独占这句「交易已取消」）', () => {
    expect(txStageView(input({ tx: tx({ status: 'CANCELLED' }) }))).toBeNull()
  })

  test('没有封面图（coverUrl === null）不崩，交给页面画占位图', () => {
    const view = txStageView(
      input({
        listing: { title: 'K380 键盘', coverUrl: null },
        tx: tx({ status: 'PENDING_MEETUP' }),
      }),
    )
    expect(view?.bubble?.coverUrl).toBeNull()
  })
})
