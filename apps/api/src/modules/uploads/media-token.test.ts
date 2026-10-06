import { expect, test } from 'bun:test'
import { MEDIA_TOKEN, tokensEqual } from './media-token'

/** 真实令牌是 `nonce || ciphertext || authTag` 的 base64url（本仓实测 43 字符起步）。 */
const TOKEN = 'A'.repeat(43)
/** 与 `TOKEN` 等长、只差最后一个字符。 */
const SAME_LENGTH_OTHER = `${'A'.repeat(42)}B`
/** 与 `TOKEN` 等长、首字符就不同：`===` 会在第一个字节短路，这里必须逐字节比完。 */
const SAME_LENGTH_FIRST_DIFF = `B${'A'.repeat(42)}`

test('tokensEqual：内容相同的令牌判相等', () => {
  expect(tokensEqual(TOKEN, TOKEN)).toBe(true)
  // 独立字符串实例（不是同一引用）：相等性来自内容，不是引用。
  expect(tokensEqual(TOKEN, `${'A'.repeat(43)}`)).toBe(true)
})

test('tokensEqual：等长但内容不同必须判不等', () => {
  expect(tokensEqual(TOKEN, SAME_LENGTH_OTHER)).toBe(false)
  expect(tokensEqual(SAME_LENGTH_OTHER, TOKEN)).toBe(false)
  expect(tokensEqual(TOKEN, SAME_LENGTH_FIRST_DIFF)).toBe(false)
  expect(tokensEqual(SAME_LENGTH_FIRST_DIFF, TOKEN)).toBe(false)
})

test('tokensEqual：长度不同判不等且不抛异常', () => {
  // `timingSafeEqual` 对不等长会抛 "Input buffers must have the same byte length"，
  // 所以实现必须先比长度；这里同时钉住「不抛」。
  expect(tokensEqual(TOKEN, 'A'.repeat(42))).toBe(false)
  expect(tokensEqual(TOKEN, 'A'.repeat(44))).toBe(false)
  expect(tokensEqual('A'.repeat(42), TOKEN)).toBe(false)
  expect(tokensEqual('', TOKEN)).toBe(false)
  expect(tokensEqual(TOKEN, '')).toBe(false)
})

test('tokensEqual：空串边界（两个空串相等；正则闸在调用前就拦掉空令牌）', () => {
  expect(tokensEqual('', '')).toBe(true)
  expect(tokensEqual('', 'A')).toBe(false)
})

test('MEDIA_TOKEN：只放行 base64url 形状，且长度界是 20..400', () => {
  expect(MEDIA_TOKEN.test(TOKEN)).toBe(true)
  expect(MEDIA_TOKEN.test('A'.repeat(20))).toBe(true)
  expect(MEDIA_TOKEN.test('A'.repeat(400))).toBe(true)
  expect(MEDIA_TOKEN.test('A'.repeat(19))).toBe(false)
  expect(MEDIA_TOKEN.test('A'.repeat(401))).toBe(false)
  expect(MEDIA_TOKEN.test('')).toBe(false)
  // base64**标准**字母表的 `+` / `/` 与填充 `=` 不在 base64url 里，必须拒。
  for (const illegal of ['+'.repeat(20), '/'.repeat(20), '='.repeat(20), `${'A'.repeat(19)}+`]) {
    expect(MEDIA_TOKEN.test(illegal)).toBe(false)
  }
  // `-` / `_` 是 base64url 的合法字符。
  expect(MEDIA_TOKEN.test('-_'.repeat(10))).toBe(true)
})
