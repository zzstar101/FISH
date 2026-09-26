/**
 * 有界重试的边界测试（#228 §7：只重试明确瞬时错误，禁止无上限重试）。
 *
 * 这里不重复 provider 的模拟上游用例，只钉两件事：重放次数上界，以及「配置错误不会伪装成
 * 审核错误」——`attempts < 1` 时不能抛出 `undefined`，否则调用方按 `ContentModerationError`
 * 分支就会漏过去。
 */
import { describe, expect, test } from 'bun:test'
import { withBoundedRetry } from './retry'
import { ContentModerationError } from './types'

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run()
    return null
  } catch (error) {
    return error
  }
}

describe('withBoundedRetry', () => {
  test('可重试错误重放到 attempts 上限后抛出原错误', async () => {
    const throttled = new ContentModerationError({ reason: 'throttled' })
    let calls = 0

    const error = await captureError(() =>
      withBoundedRetry(
        () => {
          calls += 1
          return Promise.reject(throttled)
        },
        { attempts: 3, baseDelayMs: 0 },
      ),
    )

    expect(calls).toBe(3)
    expect(error).toBe(throttled)
  })

  test('不可重试错误只调用一次', async () => {
    const rejected = new ContentModerationError({ reason: 'upstream_rejected' })
    let calls = 0

    const error = await captureError(() =>
      withBoundedRetry(
        () => {
          calls += 1
          return Promise.reject(rejected)
        },
        { attempts: 3, baseDelayMs: 0 },
      ),
    )

    expect(calls).toBe(1)
    expect(error).toBe(rejected)
  })

  test('attempts < 1 是配置错误：直接拒绝，而不是抛出 undefined', async () => {
    for (const attempts of [0, -1, 1.5]) {
      let calls = 0
      const error = await captureError(() =>
        withBoundedRetry(
          () => {
            calls += 1
            return Promise.resolve('ok')
          },
          { attempts, baseDelayMs: 0 },
        ),
      )

      expect(calls).toBe(0)
      expect(error).toBeInstanceOf(RangeError)
    }
  })
})
