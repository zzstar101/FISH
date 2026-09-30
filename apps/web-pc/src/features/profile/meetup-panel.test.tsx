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

test('a consumed credential is reported as consumed', () => {
  const html = view({
    role: 'buyer',
    status: 'CONSUMED',
    consumedAt: '2026-01-02T00:00:00.000Z',
  })
  expect(html).toContain('已核销')
  expect(html).toContain('核销')
})

test('the success notice hands the next step back to the confirm button', () => {
  const html = view({
    role: 'buyer',
    notice: { tone: 'success', text: '交易码已核销。接下来请与对方各自点一次「确认完成面交」。' },
  })
  expect(html).toContain('确认完成面交')
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
