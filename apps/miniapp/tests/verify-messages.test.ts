import { describe, expect, test } from 'bun:test'
import {
  sendErrorMessage,
  verifyErrorMessage,
  verifyNeedsResend,
} from '../src/features/verify/messages'

/**
 * 校园认证页「后端错误码 → 行内文案 / 是否解锁重发」的映射（#89 需求 3）。
 *
 * 锁两件事：
 * 1. 每个后端码都有**明确**文案（不是落到「操作失败」这种笼统兜底）；
 * 2. 410 `CODE_EXPIRED` / 409 `CODE_CONSUMED` / 429 `TOO_MANY_ATTEMPTS` 必须解锁重发 ——
 *    否则用户手上这枚码已经废了，却还被自己的 60 秒倒计时锁着只能干等。
 *
 * 断言刻意传一个**与页面文案明显不同的哨兵 message**：若映射表被清空，`*ErrorMessage`
 * 会退回透传后端原话，`not.toBe(BACKEND)` 立刻失败。传后端真实文案则不行 ——
 * `CODE_EXPIRED` 等码的页面文案与后端 message 本就逐字相同，「命中映射」与
 * 「兜底透传」无法区分，测试会在实现退化成透传时依然全绿。
 */
const BACKEND = '后端原话'

describe('verifyErrorMessage', () => {
  test('码错误 / 过期 / 已用 / 尝试过多各自命中页面文案，不是透传后端原话', () => {
    const codes = ['CODE_INVALID', 'CODE_EXPIRED', 'CODE_CONSUMED', 'TOO_MANY_ATTEMPTS']
    const messages = codes.map((code) => verifyErrorMessage(code, BACKEND))
    for (const message of messages) expect(message).not.toBe(BACKEND)
    // 四种状态不能收敛成同一句话，否则用户分不清该重输还是该重发
    expect(new Set(messages).size).toBe(codes.length)
  })

  test('RATE_LIMITED 透传后端 message（含「还有几秒 / 今日已用完」）', () => {
    const backendMessage = '发送太频繁，请 42 秒后再试'
    expect(verifyErrorMessage('RATE_LIMITED', backendMessage)).toBe(backendMessage)
  })

  test('409 邮箱占用命中页面文案，未知码才透传后端原话', () => {
    expect(verifyErrorMessage('EMAIL_ALREADY_BOUND', BACKEND)).not.toBe(BACKEND)
    expect(verifyErrorMessage('SOMETHING_NEW', BACKEND)).toBe(BACKEND)
  })
})

describe('sendErrorMessage', () => {
  test('邮箱占用命中页面文案，未知码透传后端原话', () => {
    expect(sendErrorMessage('EMAIL_ALREADY_BOUND', BACKEND)).not.toBe(BACKEND)
    expect(sendErrorMessage('UNKNOWN', BACKEND)).toBe(BACKEND)
  })

  test('RATE_LIMITED 透传后端 message', () => {
    const backendMessage = '今日发送次数已达上限，请明天再试'
    expect(sendErrorMessage('RATE_LIMITED', backendMessage)).toBe(backendMessage)
  })
})

describe('verifyNeedsResend', () => {
  test('码已不可用的三种失败要解锁重发', () => {
    expect(verifyNeedsResend('CODE_EXPIRED')).toBe(true)
    expect(verifyNeedsResend('CODE_CONSUMED')).toBe(true)
    expect(verifyNeedsResend('TOO_MANY_ATTEMPTS')).toBe(true)
  })

  test('码错误只是输错，不该解锁重发（否则等于鼓励用户放弃这枚码）', () => {
    expect(verifyNeedsResend('CODE_INVALID')).toBe(false)
    expect(verifyNeedsResend('RATE_LIMITED')).toBe(false)
  })
})
