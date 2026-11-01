import { describe, expect, test } from 'bun:test'
import { MAX_SEND_ATTEMPTS, planAttempt, retryDelayMs } from './outcome'

/**
 * 投递状态机的决策用例（#462）。
 *
 * 每个分支都对应一条冻结口径：43101 = 用户拒绝/没次数（不重试、本地计数置 0）、
 * 参数类错误重试无意义、网络类退避后最多 3 次。这层是纯函数，所以这些结论不依赖
 * 真 Postgres 就能钉住。
 */
describe('planAttempt', () => {
  test('errcode 0（成功）→ SENT', () => {
    expect(planAttempt({ ok: true }, 1)).toEqual({ status: 'SENT' })
  })

  test('43101（用户拒绝/无次数）→ SKIPPED 并把该 kind 的额度置 0，不重试', () => {
    expect(
      planAttempt({ ok: false, reason: 'no-quota', errcode: 43101, detail: 'errcode=43101' }, 1),
    ).toEqual({ status: 'SKIPPED', error: 'errcode=43101', clearGrant: true, errcode: 43101 })
  })

  test.each([40003, 40037, 41030, 47003])('参数类错误 %d → FAILED（不重试）', (errcode) => {
    expect(
      planAttempt({ ok: false, reason: 'permanent', errcode, detail: `errcode=${errcode}` }, 1),
    ).toEqual({ status: 'FAILED', error: `errcode=${errcode}`, errcode })
  })

  test('本地跳过（没有 openid / 模板已摘掉）→ SKIPPED，不扣额度、不重试', () => {
    expect(planAttempt({ ok: false, reason: 'skip', detail: 'no_openid' }, 1)).toEqual({
      status: 'SKIPPED',
      error: 'no_openid',
      clearGrant: false,
    })
  })

  test('可重试失败：前两次退避重试，第 3 次判 FAILED', () => {
    const retryable = { ok: false as const, reason: 'retryable' as const, detail: 'timeout' }

    const first = planAttempt(retryable, 1)
    expect(first).toEqual({
      status: 'RETRY',
      error: 'timeout',
      errcode: null,
      nextAttemptInMs: 30_000,
    })

    const second = planAttempt(retryable, 2)
    expect(second).toEqual({
      status: 'RETRY',
      error: 'timeout',
      errcode: null,
      nextAttemptInMs: 120_000,
    })

    // 含本次共 3 次：放弃。
    expect(planAttempt(retryable, MAX_SEND_ATTEMPTS)).toEqual({
      status: 'FAILED',
      error: 'timeout',
      errcode: null,
    })
  })

  test('可重试失败保留上游 errcode（-1 系统繁忙也是合法值）', () => {
    expect(
      planAttempt({ ok: false, reason: 'retryable', errcode: -1, detail: 'errcode=-1' }, 1),
    ).toEqual({ status: 'RETRY', error: 'errcode=-1', errcode: -1, nextAttemptInMs: 30_000 })
  })
})

describe('retryDelayMs', () => {
  test('退避阶梯单调不减，越界取最后一档', () => {
    expect(retryDelayMs(1)).toBe(30_000)
    expect(retryDelayMs(2)).toBe(120_000)
    expect(retryDelayMs(9)).toBe(120_000)
    // 0 / 负数不该出现（attempts 至少 1），但退化到第一档而不是 NaN
    expect(retryDelayMs(0)).toBe(30_000)
  })
})
