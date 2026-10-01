import { describe, expect, test } from 'bun:test'
import type { VerificationStatus } from '@fish/contracts/auth/verification'
import {
  canRequestCode,
  formatVerifiedDate,
  isCodeComplete,
  RESEND_COOLDOWN_MS,
  resendSecondsLeft,
  stageFromStatus,
} from './view'

const UNVERIFIED: VerificationStatus = {
  authStatus: 'UNVERIFIED',
  verifiedAt: null,
  maskedEmail: null,
}

const VERIFIED: VerificationStatus = {
  authStatus: 'VERIFIED',
  verifiedAt: '2026-10-01T02:03:04.000Z',
  maskedEmail: 'z***@gzasc.edu.cn',
}

describe('stageFromStatus', () => {
  test('状态未返回时是 loading，不能先把输入框亮出来', () => {
    expect(stageFromStatus(undefined, false)).toBe('loading')
    expect(stageFromStatus(undefined, true)).toBe('loading')
  })

  test('已认证优先于本地发码状态：服务端说 VERIFIED 就不再给表单', () => {
    expect(stageFromStatus(VERIFIED, false)).toBe('verified')
    expect(stageFromStatus(VERIFIED, true)).toBe('verified')
  })

  test('未认证按「本次是否已发码」在填邮箱与填验证码之间切换', () => {
    expect(stageFromStatus(UNVERIFIED, false)).toBe('unverified')
    expect(stageFromStatus(UNVERIFIED, true)).toBe('codeSent')
  })
})

describe('resendSecondsLeft', () => {
  test('向上取整：还有 0.2 秒也算 1 秒，避免按钮提前解锁', () => {
    expect(resendSecondsLeft(1_000, 60_000 + 200)).toBe(60)
    expect(resendSecondsLeft(59_999, 60_000)).toBe(1)
  })

  test('到点与永不过期为 0，且不会出现负数', () => {
    expect(resendSecondsLeft(60_000, 60_000)).toBe(0)
    expect(resendSecondsLeft(999_999, 60_000)).toBe(0)
    expect(resendSecondsLeft(0, null)).toBe(0)
  })

  test('服务端 60s 间隔与端上倒计时同值', () => {
    expect(RESEND_COOLDOWN_MS).toBe(60_000)
  })
})

describe('canRequestCode', () => {
  test('请求在飞或倒计时内都不给点（端上只节流，不放宽服务端限频）', () => {
    expect(canRequestCode({ pending: true, secondsLeft: 0 })).toBe(false)
    expect(canRequestCode({ pending: false, secondsLeft: 1 })).toBe(false)
    expect(canRequestCode({ pending: false, secondsLeft: 0 })).toBe(true)
  })
})

describe('isCodeComplete', () => {
  test('只认 6 位数字（与契约 VerificationCodeSchema 同口径）', () => {
    expect(isCodeComplete('123456')).toBe(true)
    for (const bad of ['12345', '1234567', '12345a', '12 456', '', '１２３４５６']) {
      expect(isCodeComplete(bad)).toBe(false)
    }
  })
})

describe('formatVerifiedDate', () => {
  test('ISO 时间取日期部分', () => {
    expect(formatVerifiedDate('2026-10-01T02:03:04.000Z')).toBe('2026-10-01')
  })

  test('缺失或非法值落成占位符，不显示 Invalid Date', () => {
    expect(formatVerifiedDate(null)).toBe('—')
    expect(formatVerifiedDate('not-a-date')).toBe('—')
  })
})
