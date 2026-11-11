import { describe, expect, test } from 'bun:test'
import type { OrderCardView } from '../src/features/transaction/adapt'
import {
  classifyConfirmFailure,
  MEETUP_CONFIRM_FAILED,
  MEETUP_CONFIRM_HINT,
  MEETUP_REDEEM_FALLBACK,
  nextConfirmPending,
} from '../src/features/transaction/meetup-code'
import {
  isRedeemableOrder,
  redeemableOrders,
  TRADE_CODE_CONFIRM_TERMINAL,
  TRADE_CODE_STAGE_TEXT,
  tradeCodeDoneText,
  tradeCodeFailureMessage,
  tradeCodeStage,
} from '../src/pkg-vision/pages/scan/trade-code'

/** 一笔「买家 · 待面交 · 真实」的订单：只改需要变化的字段 */
function order(over: Partial<OrderCardView> = {}): OrderCardView {
  return {
    id: 'tx-1',
    source: 'real',
    conversationId: 'conv-1',
    listingId: 'listing-1',
    role: 'buyer',
    amountCents: 12300,
    status: 'PENDING_MEETUP',
    createdAt: '2026-01-01T00:00:00.000Z',
    counterpart: { nickname: '对方', avatarUrl: null, verified: false },
    listing: { title: '二手显示器', coverUrl: null },
    settledDate: null,
    ...over,
  }
}

describe('可选订单', () => {
  test('买家本人 + 待面交 + 真实数据才可选', () => {
    expect(isRedeemableOrder(order())).toBe(true)
  })

  test('卖家不能核销自己出示的码', () => {
    expect(isRedeemableOrder(order({ role: 'seller' }))).toBe(false)
  })

  test('已完成 / 已取消的订单码已失效', () => {
    expect(isRedeemableOrder(order({ status: 'COMPLETED' }))).toBe(false)
    expect(isRedeemableOrder(order({ status: 'CANCELLED' }))).toBe(false)
  })

  test('演示 fixture 的假订单不能进真实核销接口', () => {
    expect(isRedeemableOrder(order({ source: 'demo' }))).toBe(false)
  })

  test('只保留可选订单，且保持读取顺序', () => {
    const items = [
      order({ id: 'a' }),
      order({ id: 'b', role: 'seller' }),
      order({ id: 'c', status: 'COMPLETED' }),
      order({ id: 'd' }),
    ]
    expect(redeemableOrders(items).map((item) => item.id)).toEqual(['a', 'd'])
  })
})

describe('浮层分屏', () => {
  const base = {
    authStatus: 'authed' as const,
    loading: false,
    failed: false,
    orders: [order()],
    pickedOrderId: null,
    confirmPending: false,
    done: false,
  }

  test('登录态没解析完先显示读取中，不误判成未登录', () => {
    expect(tradeCodeStage({ ...base, authStatus: 'unknown' })).toBe('loading')
  })

  test('未登录进「去登录」屏', () => {
    expect(tradeCodeStage({ ...base, authStatus: 'anonymous' })).toBe('guest')
  })

  test('核销成功后进完成屏', () => {
    expect(tradeCodeStage({ ...base, done: true })).toBe('done')
  })

  test('读取中 / 读取失败 / 无单三分支', () => {
    expect(tradeCodeStage({ ...base, loading: true, orders: [] })).toBe('loading')
    expect(tradeCodeStage({ ...base, failed: true, orders: [] })).toBe('failed')
    expect(tradeCodeStage({ ...base, orders: [] })).toBe('empty')
  })

  test('有单未选 = 选单屏；选中在列表里的一笔 = 输码屏', () => {
    expect(tradeCodeStage(base)).toBe('orders')
    expect(tradeCodeStage({ ...base, pickedOrderId: 'tx-1' })).toBe('input')
  })

  test('选中的订单已不在最新列表（刚被核销 / 取消）时退回选单屏', () => {
    expect(tradeCodeStage({ ...base, pickedOrderId: 'tx-gone' })).toBe('orders')
  })
})

describe('码已核销、确认未落定（审查 P1）', () => {
  const base = {
    authStatus: 'authed' as const,
    loading: false,
    failed: false,
    orders: [order()],
    pickedOrderId: 'tx-1',
    confirmPending: false,
    done: false,
  }

  test('verify 成功但 confirm 网络失败 → 停在「待确认」屏，不退成输码屏', () => {
    const failure = classifyConfirmFailure(null)
    expect(failure).toBe('retry')
    expect(
      tradeCodeStage({ ...base, confirmPending: nextConfirmPending({ kind: 'error', failure }) }),
    ).toBe('confirm')
  })

  test('进入待确认后在途重读订单（loading / 列表暂时为空）也不换屏', () => {
    expect(tradeCodeStage({ ...base, confirmPending: true, loading: true, orders: [] })).toBe(
      'confirm',
    )
  })

  test('待确认的说明用「码已核销」那句，不是核销失败兜底', () => {
    expect(TRADE_CODE_STAGE_TEXT.confirm).toBe(MEETUP_CONFIRM_HINT)
    expect(MEETUP_CONFIRM_FAILED).not.toBe(MEETUP_REDEEM_FALLBACK)
    expect(TRADE_CODE_STAGE_TEXT.confirm).not.toBe(MEETUP_REDEEM_FALLBACK)
  })

  test('重试确认成功 → 完成屏（码不用再输）', () => {
    expect(tradeCodeStage({ ...base, confirmPending: false, done: true })).toBe('done')
  })

  test('confirm 撞上终态 → 撤下确认入口，退回选单屏', () => {
    const failure = classifyConfirmFailure('TRANSACTION_NOT_IN_PENDING')
    expect(failure).toBe('terminal')
    const confirmPending = nextConfirmPending({ kind: 'error', failure })
    expect(confirmPending).toBe(false)
    // 页面同时清掉 pickedId 并重读订单，于是落回选单屏
    expect(tradeCodeStage({ ...base, pickedOrderId: null, confirmPending })).toBe('orders')
  })

  test('终态那句说「确认入口已撤下」，不误称码没核销成功', () => {
    expect(TRADE_CODE_CONFIRM_TERMINAL).toContain('确认入口已撤下')
    expect(TRADE_CODE_CONFIRM_TERMINAL).not.toBe(tradeCodeFailureMessage({ kind: 'terminal' }))
  })
})

describe('成功与失败的落点文案', () => {
  test('双侧确认齐才算完成', () => {
    expect(tradeCodeDoneText('COMPLETED')).toContain('已完成')
    expect(tradeCodeDoneText('PENDING_MEETUP')).toContain('等对方确认')
  })

  test('终态 / 出示方自核销各有一句用户读得懂的话', () => {
    expect(tradeCodeFailureMessage({ kind: 'terminal' })).toContain('已经结束')
    expect(tradeCodeFailureMessage({ kind: 'not-allowed' })).toContain('不能由你核销')
  })

  test('码错 / 已用 / 锁定等直接沿用共享文案', () => {
    const message = '交易码错误，请核对后重新输入。请确认对方展示的是本单的交易码。'
    expect(tradeCodeFailureMessage({ kind: 'message', message })).toBe(message)
  })
})
