import { expect, test } from 'bun:test'
import type { MeetupTokenResponse } from '@fish/contracts/transactions/schema'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MeetupPanelView, type MeetupPanelViewProps } from './meetup-panel'

const TOKEN: MeetupTokenResponse = {
  transactionId: 'txn_01jc000000e00800000000004t',
  code: '123456',
  qrPayload: 'fish://meetup/redeem?tx=txn_01jc000000e00800000000004t&t=abcdefghij0123456789',
}

function view(over: Partial<MeetupPanelViewProps> = {}): string {
  return renderToStaticMarkup(
    createElement(MeetupPanelView, {
      role: 'seller',
      status: null,
      consumedAt: null,
      token: null,
      qrSrc: null,
      draft: '',
      notice: null,
      issuing: false,
      redeeming: false,
      onTakeToken: () => undefined,
      onDraftChange: () => undefined,
      onRedeem: () => undefined,
      ...over,
    }),
  )
}

test('the issuer starts from a take-code button, not from a code', () => {
  const html = view()
  expect(html).toContain('出示交易码')
  expect(html).not.toContain('123456')
  // 卖家不该看到核销输入框：出示与核销是两方各自的动作
  expect(html).not.toContain('核销交易码')
})

test('the issuer sees the 6-digit code and the scannable QR once issued', () => {
  const html = view({ token: TOKEN, qrSrc: 'data:image/gif;base64,R0lGOD', status: 'ISSUED' })
  expect(html).toContain('123456')
  expect(html).toContain('data:image/gif;base64,R0lGOD')
  expect(html).toContain('重新取码（码不变）')
  expect(html).toContain('已出示，等待对方核销')
  // 取到码之后不再显示「出示交易码」这个起始动作
  expect(html).not.toContain('>出示交易码<')
})

test('the redeemer gets an input and a redeem action instead of the code', () => {
  const html = view({ role: 'buyer', status: 'ISSUED' })
  expect(html).toContain('aria-label="交易码"')
  expect(html).toContain('核销交易码')
  expect(html).not.toContain('出示交易码')
})

test('an empty draft cannot be redeemed', () => {
  expect(view({ role: 'buyer', draft: '  ' })).toContain('disabled=""')
  expect(view({ role: 'buyer', draft: '123456' })).not.toContain('disabled=""')
})

test('a consumed credential offers no action on either side', () => {
  // 凭证一次性且「已核销不复活」：再给动作只会撞 404 / 409
  const buyerHtml = view({
    role: 'buyer',
    status: 'CONSUMED',
    consumedAt: '2026-01-02T00:00:00.000Z',
  })
  expect(buyerHtml).toContain('凭证状态：已核销')
  expect(buyerHtml).not.toContain('aria-label="交易码"')
  expect(buyerHtml).not.toContain('核销交易码')

  const sellerHtml = view({ status: 'CONSUMED', token: TOKEN })
  expect(sellerHtml).toContain('本单不需要再出示')
  expect(sellerHtml).not.toContain('>出示交易码<')
  expect(sellerHtml).not.toContain('重新取码（码不变）')
  // 已核销的码不再回显，免得被当成还能用的凭证
  expect(sellerHtml).not.toContain('123456')
})

test('the success notice asks only the redeemer to confirm, not both sides', () => {
  // 卖家那一侧的确认由核销本身盖上（展示码即同意），所以文案不能再要求「双方各自确认」
  const html = view({
    role: 'buyer',
    notice: {
      tone: 'success',
      text: '交易码已核销，卖家一侧的确认已随核销完成。你点一次「确认完成面交」即可完成这笔交易。',
    },
  })
  expect(html).toContain('确认完成面交')
  expect(html).not.toContain('各自点一次')
})

test('the issuer is told that showing the code counts as their agreement', () => {
  const html = view({ status: 'NONE' })
  expect(html).toContain('出示交易码即视为你同意这次面交')
})

test('a locked-out code reports its own message rather than a generic failure', () => {
  const html = view({
    role: 'buyer',
    notice: {
      tone: 'warn',
      text: '错误次数过多，已临时锁定。请让对方重新打开一次「交易码」页面，再试同一枚码。',
    },
  })
  expect(html).toContain('临时锁定')
})
