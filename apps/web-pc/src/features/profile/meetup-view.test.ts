import { describe, expect, test } from 'bun:test'
import { buildMeetupQrPayload } from '@fish/contracts/transactions/meetup-qr'
import { ApiError } from '../../lib/api-client'
import {
  classifyRedeemInput,
  hasConfirmedOwnSide,
  meetupIssueFailure,
  meetupRedeemFailure,
  meetupStatusLabel,
  redeemInputMessage,
} from './meetup-view'

const TX = 'txn_01jc000000e00800000000004t'
const OTHER_TX = 'txn_01jc000000e00800000000005t'
const TOKEN = 'abcdefghij0123456789'

describe('classifyRedeemInput', () => {
  test('accepts a 6-digit code, trimming surrounding whitespace', () => {
    expect(classifyRedeemInput('  123456 ', TX)).toEqual({ kind: 'code', code: '123456' })
  })

  test('accepts a payload that belongs to this transaction', () => {
    const payload = buildMeetupQrPayload(TX, TOKEN)
    expect(classifyRedeemInput(payload, TX)).toEqual({ kind: 'qr', token: TOKEN })
  })

  test('separates "belongs to another order" from "not a code at all"', () => {
    // 两个分支的用户动作不同：前者是拿错了单，后者是输错了内容
    const other = buildMeetupQrPayload(OTHER_TX, TOKEN)
    expect(classifyRedeemInput(other, TX)).toEqual({ kind: 'wrongTransaction' })
    expect(classifyRedeemInput('这不是码', TX)).toEqual({ kind: 'invalid' })
    expect(classifyRedeemInput('12345', TX)).toEqual({ kind: 'invalid' })
    expect(classifyRedeemInput('1234567', TX)).toEqual({ kind: 'invalid' })
  })
})

describe('redeemInputMessage', () => {
  test('only reports a message for inputs that never reach the server', () => {
    expect(redeemInputMessage({ kind: 'code', code: '123456' })).toBeNull()
    expect(redeemInputMessage({ kind: 'qr', token: TOKEN })).toBeNull()
    expect(redeemInputMessage({ kind: 'wrongTransaction' })).toBe(
      '这枚交易码属于另一笔订单，请核对后重试。',
    )
    expect(redeemInputMessage({ kind: 'invalid' })).toContain('6 位交易码')
  })
})

describe('meetupRedeemFailure', () => {
  test('keeps each contract code actionable instead of collapsing to one message', () => {
    expect(meetupRedeemFailure(new ApiError('MEETUP_TOKEN_INVALID', 422, 'x')).message).toContain(
      '交易码错误',
    )
    expect(meetupRedeemFailure(new ApiError('MEETUP_TOKEN_CONSUMED', 409, 'x')).message).toContain(
      '已被使用',
    )
    expect(meetupRedeemFailure(new ApiError('MEETUP_TOKEN_LOCKED', 429, 'x')).message).toContain(
      '临时锁定',
    )
    expect(meetupRedeemFailure(new ApiError('MEETUP_TOKEN_NOT_FOUND', 404, 'x')).message).toContain(
      '还没有出示',
    )
    expect(
      meetupRedeemFailure(new ApiError('MEETUP_TOKEN_NOT_ALLOWED', 403, 'x')).message,
    ).toContain('你自己出示的')
    expect(meetupRedeemFailure(new Error('network')).message).toBe('核销失败，请检查网络后重试。')
  })

  test('treats a terminal transaction as a refresh, not as a plain failure', () => {
    const failure = meetupRedeemFailure(new ApiError('TRANSACTION_NOT_IN_PENDING', 409, 'x'))
    expect(failure.refresh).toBe(true)
  })

  test('does not ask for a refresh when the code was simply mistyped', () => {
    // 输错码时服务端状态没变，刷新只会把用户刚看到的码清掉
    expect(meetupRedeemFailure(new ApiError('MEETUP_TOKEN_INVALID', 422, 'x')).refresh).toBe(false)
    expect(meetupRedeemFailure(new ApiError('MEETUP_TOKEN_LOCKED', 429, 'x')).refresh).toBe(false)
  })
})

describe('meetupIssueFailure', () => {
  test('maps the issuer-side codes', () => {
    expect(meetupIssueFailure(new ApiError('MEETUP_TOKEN_NOT_ALLOWED', 403, 'x'))).toEqual({
      message: '只有交易的卖家可以出示交易码',
      refresh: false,
    })
    // 取码路径的 404 是 TRANSACTION_NOT_FOUND；MEETUP_TOKEN_NOT_FOUND 只出现在
    // 核销与状态查询（service.ts 的 getMeetupTokenStatus / consumeMeetup）
    expect(meetupIssueFailure(new ApiError('TRANSACTION_NOT_FOUND', 404, 'x')).refresh).toBe(true)
    expect(meetupIssueFailure(new ApiError('MEETUP_TOKEN_NOT_FOUND', 404, 'x'))).toEqual({
      message: 'x',
      refresh: false,
    })
    expect(meetupIssueFailure(new Error('network'))).toEqual({
      message: '交易码获取失败，请重试',
      refresh: false,
    })
  })
})

describe('meetupStatusLabel', () => {
  test('labels every status the contract allows', () => {
    expect(meetupStatusLabel('NONE')).toBe('尚未取码')
    expect(meetupStatusLabel('ISSUED')).toBe('已出示，等待对方核销')
    expect(meetupStatusLabel('CONSUMED')).toBe('已核销')
  })
})

describe('hasConfirmedOwnSide', () => {
  test('reads only the viewer own column', () => {
    expect(
      hasConfirmedOwnSide({
        role: 'buyer',
        buyerConfirmedAt: '2026-01-02T00:00:00.000Z',
        sellerConfirmedAt: null,
      }),
    ).toBe(true)
    expect(
      hasConfirmedOwnSide({
        role: 'buyer',
        buyerConfirmedAt: null,
        sellerConfirmedAt: '2026-01-02T00:00:00.000Z',
      }),
    ).toBe(false)
    expect(
      hasConfirmedOwnSide({
        role: 'seller',
        buyerConfirmedAt: null,
        sellerConfirmedAt: '2026-01-02T00:00:00.000Z',
      }),
    ).toBe(true)
    expect(
      hasConfirmedOwnSide({ role: 'seller', buyerConfirmedAt: null, sellerConfirmedAt: null }),
    ).toBe(false)
  })
})
