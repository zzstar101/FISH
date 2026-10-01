import { describe, expect, test } from 'bun:test'
import { PhoneErrorCodeSchema } from './phone'
import { AuthErrorCodeAllSchema } from './verification'

/**
 * 手机号子域错误码（#204）。
 *
 * 锁的是「**同一个码只有一个真源**」这件事：`PhoneErrorCodeSchema` 必须是
 * `AuthErrorCodeSchema` 的子集（而不是另抄一份字面量），否则 `PHONE_CODE_INVALID`
 * 会在两处各定义一次，改了一处漏了另一处不会报错；同时这些码必须都在
 * `AuthErrorCodeAll` 里，`AuthError` 才收窄得了它们（与 #197 `scan.test.ts` 同一口径）。
 */
describe('PhoneErrorCodeSchema', () => {
  test('三个手机号码都并入 AuthErrorCodeAll（AuthError 能收窄它们）', () => {
    expect([...PhoneErrorCodeSchema.options].sort()).toEqual([
      'PHONE_ALREADY_BOUND',
      'PHONE_CODE_INVALID',
      'PHONE_UPSTREAM_UNAVAILABLE',
    ])
    for (const code of PhoneErrorCodeSchema.options) {
      expect(AuthErrorCodeAllSchema.options).toContain(code)
    }
  })

  test('是子集而非整个联合：不含跨子域通用码', () => {
    for (const code of ['WECHAT_DISABLED', 'UNAUTHENTICATED', 'INVALID_CREDENTIALS']) {
      expect(PhoneErrorCodeSchema.options).not.toContain(code)
    }
  })
})
