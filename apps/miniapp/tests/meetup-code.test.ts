import { describe, expect, test } from 'bun:test'
import {
  consumedCodeVerdict,
  isMeetupCodeShaped,
  MEETUP_REDEEM_FALLBACK,
  meetupCodeInputError,
  meetupRedeemFailure,
  normalizeMeetupCode,
} from '../src/features/transaction/meetup-code'

describe('交易码格式', () => {
  test('只留数字并截到 6 位（粘贴整串 / 带空格分隔都能用）', () => {
    expect(normalizeMeetupCode('123456')).toBe('123456')
    expect(normalizeMeetupCode(' 12 34-56 ')).toBe('123456')
    expect(normalizeMeetupCode('1234567890')).toBe('123456')
    expect(normalizeMeetupCode('abc')).toBe('')
  })

  test('不满 6 位给格式提示，满 6 位放行', () => {
    expect(meetupCodeInputError('12345')).toBe('交易码是 6 位数字，请输满 6 位。')
    expect(meetupCodeInputError('')).toBe('交易码是 6 位数字，请输满 6 位。')
    expect(meetupCodeInputError('123456')).toBeNull()
  })

  test('剥掉非数字后正好 6 位仍然非法：混入字母的输入不算交易码（审查 12）', () => {
    expect(meetupCodeInputError('12345a6')).toBe('交易码是 6 位数字，请输满 6 位。')
    expect(meetupCodeInputError('12 3456')).toBe('交易码是 6 位数字，请输满 6 位。')
    expect(isMeetupCodeShaped('123456')).toBe(true)
    expect(isMeetupCodeShaped('12345a')).toBe(false)
    expect(isMeetupCodeShaped('1234567')).toBe(false)
  })
})

describe('「码已被用掉」重读交易的落点（审查 2）', () => {
  const tx = (over: {
    status?: 'PENDING_MEETUP' | 'COMPLETED' | 'CANCELLED'
    buyer?: boolean
  }) => ({
    status: over.status ?? ('PENDING_MEETUP' as const),
    buyerConfirmedAt: over.buyer === false ? null : '2026-01-01T00:00:00.000Z',
  })

  test('还在待面交、本侧未确认 → 只差确认这一步', () => {
    expect(consumedCodeVerdict(tx({ buyer: false }))).toBe('needs-confirm')
  })

  test('本侧已确认 → 已经完成，别再让人确认一次', () => {
    expect(consumedCodeVerdict(tx({}))).toBe('confirmed')
  })

  test('交易已离待面交 → 终态', () => {
    expect(consumedCodeVerdict(tx({ status: 'COMPLETED' }))).toBe('terminal')
    expect(consumedCodeVerdict(tx({ status: 'CANCELLED' }))).toBe('terminal')
  })
})

describe('核销失败分派', () => {
  test('交易已离开待面交 → 终态（页面要重读交易并撤下核销入口）', () => {
    expect(meetupRedeemFailure('TRANSACTION_NOT_IN_PENDING')).toEqual({ kind: 'terminal' })
  })

  test('出示方自核销 → not-allowed', () => {
    expect(meetupRedeemFailure('MEETUP_TOKEN_NOT_ALLOWED')).toEqual({ kind: 'not-allowed' })
  })

  test('码错 / 已用 / 锁定 / 未出码 → 各自的行内文案', () => {
    expect(meetupRedeemFailure('MEETUP_TOKEN_INVALID')).toEqual({
      kind: 'message',
      message: '交易码错误，请核对后重新输入。请确认对方展示的是本单的交易码。',
    })
    expect(meetupRedeemFailure('MEETUP_TOKEN_CONSUMED')).toEqual({
      kind: 'message',
      message: '这个交易码已被使用，不能重复核销。',
    })
    expect(meetupRedeemFailure('MEETUP_TOKEN_LOCKED')).toEqual({
      kind: 'message',
      message: '错误次数过多，已临时锁定。请让对方重新打开一次「交易码」页面，再试同一枚码。',
    })
    expect(meetupRedeemFailure('MEETUP_TOKEN_NOT_FOUND')).toEqual({
      kind: 'message',
      message: '对方还没有出示本单的交易码。',
    })
  })

  test('没有错误码（断网等）/ 未知错误码 → 同一句网络兜底', () => {
    expect(meetupRedeemFailure(null)).toEqual({
      kind: 'message',
      message: MEETUP_REDEEM_FALLBACK,
    })
    expect(meetupRedeemFailure('SOMETHING_NEW')).toEqual({
      kind: 'message',
      message: MEETUP_REDEEM_FALLBACK,
    })
  })
})

describe('核销链路只有一份', () => {
  // 断言读页面源码而不是行为：这里要证明的是「没有第二份实现」，行为用例证明不了缺席
  test('面交页与相机页浮层都调共享实现，页面里不再自带错误文案表 / 接口调用', async () => {
    const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text()

    const meetup = await read('../src/pkg-trade/pages/transaction-meetup/index.tsx')
    expect(meetup).toContain('meetupRedeemFailure(')
    expect(meetup).toContain('normalizeMeetupCode(')
    expect(meetup).toContain('meetupCodeInputError(')
    expect(meetup).not.toContain('MEETUP_TOKEN_CONSUMED:')
    expect(meetup).not.toContain('核销失败，请检查网络后重试。')

    const scan = await read('../src/pkg-vision/pages/scan/index.tsx')
    expect(scan).toContain('consumeMeetupCode(')
    expect(scan).not.toContain('verifyMeetupCode(')
  })

  // 审查 13：两个核销入口都必须让 `nextAction` 在共享实现里被解释，页面不得自己串 verify→confirm
  test('nextAction 只在 meetup-verify 里解释，面交页也走它', async () => {
    const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text()

    const verify = await read('../src/features/transaction/meetup-verify.ts')
    expect(verify).toContain('finishMeetupVerification')
    expect(verify).toContain('AFTER_VERIFY[verified.nextAction]')

    const meetup = await read('../src/pkg-trade/pages/transaction-meetup/index.tsx')
    expect(meetup).toContain('finishMeetupVerification(')
    // 面交页手里只有核销响应对象，没有「自己决定下一步」的余地
    expect(meetup).not.toContain('confirmTransaction(targetId)')
  })
})
