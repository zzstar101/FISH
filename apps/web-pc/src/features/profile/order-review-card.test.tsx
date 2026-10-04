import { describe, expect, test } from 'bun:test'
import type { TransactionReview } from '@fish/contracts/transaction-reviews/schema'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { OrderReviewCardView, ReviewForm } from './order-review-card'

const REVIEW: TransactionReview = {
  id: 'rvw_01jc000000e00800000000000r',
  transactionId: 'txn_01jc000000e00800000000004t',
  rating: 'POSITIVE',
  body: '很爽快的买家，面交顺利',
  images: [],
  createdAt: '2026-01-01T00:00:00.000Z',
}

function renderView(overrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(OrderReviewCardView, {
      loading: false,
      error: false,
      review: null,
      submitting: false,
      errorMessage: null,
      dialogOpen: false,
      onDialogOpenChange: () => undefined,
      onRetry: () => undefined,
      onSubmit: () => undefined,
      ...overrides,
    }),
  )
}

function renderForm(overrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(ReviewForm, {
      errorMessage: null,
      onCancel: () => undefined,
      onSubmit: () => undefined,
      submitting: false,
      ...overrides,
    }),
  )
}

describe('OrderReviewCardView 状态分支', () => {
  test('读取中给加载文案，不给写入口', () => {
    const html = renderView({ loading: true })
    expect(html).toContain('正在读取评价状态')
    expect(html).not.toContain('写评价')
  })

  test('评价边读失败：状态未知 ≠ 没评过，给重试而不给写入口', () => {
    const html = renderView({ error: true })
    expect(html).toContain('评价状态读取失败')
    expect(html).toContain('重试')
    expect(html).not.toContain('写评价')
  })

  test('已评过：只读展示档次与评语，不再给「写评价」入口（防重复第一道闸）', () => {
    const html = renderView({ review: REVIEW })
    expect(html).toContain('好评')
    expect(html).toContain('很爽快的买家，面交顺利')
    expect(html).toContain('你已评价过这笔交易')
    expect(html).not.toContain('写评价')
  })

  test('只打分没写字：已评态不渲染空评语段', () => {
    const html = renderView({ review: { ...REVIEW, body: null } })
    expect(html).toContain('好评')
    expect(html).not.toContain('<p class="mt-2 font-medium text-sm"></p>')
  })

  test('未评过：给「写评价」入口', () => {
    const html = renderView()
    expect(html).toContain('写评价')
  })

  test('提交错误透传给 alert 段', () => {
    const html = renderView({ errorMessage: '你已评价过这笔交易' })
    expect(html).toContain('你已评价过这笔交易')
  })
})

describe('ReviewForm', () => {
  test('三档评分与可选评语都在，未选档时提交禁用', () => {
    const html = renderForm()
    expect(html).toContain('好评')
    expect(html).toContain('中评')
    expect(html).toContain('差评')
    expect(html).toContain('评语')
    expect(html).toContain('disabled')
    expect(html).toContain('提交评价')
  })

  test('提交中禁用两颗按钮', () => {
    const html = renderForm({ submitting: true })
    expect(html).toContain('正在提交…')
  })

  test('提交失败的文案渲染在弹窗内（模态遮罩外卡片上的 alert 用户看不见）', () => {
    const html = renderForm({ errorMessage: '评语包含违规内容' })
    expect(html).toContain('评语包含违规内容')
    expect(html).toContain('role="alert"')
  })
})
