import { describe, expect, test } from 'bun:test'
import { VerificationErrorCodeSchema } from '@fish/contracts/auth/verification'
import { sendErrorMessage, verifyErrorMessage, verifyNeedsResend } from './messages'

describe('认证域错误码 → 文案', () => {
  test('契约里每个校验错误码都有自己的可执行文案，不折叠成一句「认证失败」', () => {
    // 直接遍历契约的取值：契约新增错误码时这里会红，逼着补文案。
    const codes = VerificationErrorCodeSchema.options.filter((code) => code !== 'RATE_LIMITED')
    const copies = codes.map((code) => verifyErrorMessage(code, '__backend__'))

    expect(codes).toContain('EMAIL_ALREADY_BOUND')
    for (const [index, copy] of copies.entries()) {
      expect(copy, `错误码 ${codes[index]} 落到了兜底文案`).not.toBe('__backend__')
    }
    // 逐条不同：否则用户看到的是同一句笼统提示，等于没做映射。
    expect(new Set(copies).size).toBe(codes.length)
  })

  test('RATE_LIMITED 与未知码透传服务端 message（「还有几秒」这类信息编不出来）', () => {
    expect(verifyErrorMessage('RATE_LIMITED', '发送太频繁，请 42 秒后再试')).toBe(
      '发送太频繁，请 42 秒后再试',
    )
    expect(sendErrorMessage('RATE_LIMITED', '今日发送次数已达上限，请明天再试')).toBe(
      '今日发送次数已达上限，请明天再试',
    )
    expect(verifyErrorMessage('BRAND_NEW_CODE', '服务端新说法')).toBe('服务端新说法')
    expect(sendErrorMessage('BRAND_NEW_CODE', '服务端新说法')).toBe('服务端新说法')
  })

  test('发码阶段的绑定冲突与域名校验各有说法', () => {
    expect(sendErrorMessage('EMAIL_ALREADY_BOUND', '__backend__')).toBe('该校园邮箱已绑定其他账号')
    expect(sendErrorMessage('VALIDATION_FAILED', '__backend__')).toBe('请使用校园教育邮箱')
  })

  test('只有「这枚码已不可用」的失败码才解锁重发', () => {
    for (const code of ['CODE_EXPIRED', 'CODE_CONSUMED', 'TOO_MANY_ATTEMPTS']) {
      expect(verifyNeedsResend(code), `${code} 应解锁重发`).toBe(true)
    }
    // CODE_INVALID 不解锁：码本身还有效，用户该做的是核对而不是再发一枚。
    for (const code of [
      'CODE_INVALID',
      'RATE_LIMITED',
      'EMAIL_ALREADY_BOUND',
      'ALREADY_VERIFIED',
      'VALIDATION_FAILED',
    ]) {
      expect(verifyNeedsResend(code), `${code} 不应解锁重发`).toBe(false)
    }
  })
})
