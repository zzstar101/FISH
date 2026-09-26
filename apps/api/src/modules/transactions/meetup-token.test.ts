import { describe, expect, test } from 'bun:test'
import { parseMeetupQrPayload } from '@fish/contracts/transactions/meetup-qr'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { MeetupTokenCrypto } from './meetup-token'

const SECRET = 'test-meetup-secret-0123456789abcdef'
const OTHER_SECRET = 'another-meetup-secret-0123456789abc'
const TX = '01990000-0000-7000-8000-0000000000f1'
const OTHER_TX = '01990000-0000-7000-8000-0000000000f2'

describe('meetup token crypto (#175 确定性派生)', () => {
  test('同一枚 (密钥, 交易 id) 恒定派生同一枚 6 位码与 QR token（可重放的前提）', () => {
    const crypto = new MeetupTokenCrypto(SECRET)
    const code = crypto.deriveCode(TX)
    const token = crypto.deriveToken(TX)
    // 反复读取（重进页面 / 换端 / 重新登录 / 进程重启）都是同一枚
    for (let i = 0; i < 20; i++) {
      expect(crypto.deriveCode(TX)).toBe(code)
      expect(crypto.deriveToken(TX)).toBe(token)
    }
    // 形状：6 位数字；token 能进 QR payload（构造器会校验 base64url 字符集）
    expect(code).toMatch(/^\d{6}$/)
    expect(
      parseMeetupQrPayload(
        crypto.qrPayload(encodePublicId(PUBLIC_ID_PREFIX.transaction, TX), token),
      ),
    ).toEqual({
      transactionId: encodePublicId(PUBLIC_ID_PREFIX.transaction, TX),
      token,
    })
  })

  test('不同交易 / 不同密钥派生出不同的码（码不是公开输入的裸哈希）', () => {
    const crypto = new MeetupTokenCrypto(SECRET)
    expect(crypto.deriveCode(TX)).not.toBe(crypto.deriveCode(OTHER_TX))
    expect(crypto.deriveToken(TX)).not.toBe(crypto.deriveToken(OTHER_TX))

    const other = new MeetupTokenCrypto(OTHER_SECRET)
    expect(other.deriveCode(TX)).not.toBe(crypto.deriveCode(TX))
    expect(other.deriveToken(TX)).not.toBe(crypto.deriveToken(TX))
  })

  /**
   * 验收要求的说明与用例：**没有服务端密钥无法离线枚举 10^6 空间**。
   * 拖库者手里有的只是 transactionId（公开）与 code_hash（HMAC(secret, code)）：
   * - 码本身 = HMAC(secret, "code:" + transactionId) 的截断，密钥未知 → 算不出候选码；
   * - 比对列也带密钥 → 就算他把 10^6 个候选码逐个用公开哈希（或换一把密钥）去撞，
   *   也得不到与 code_hash 相同的值。所以 10^6 的码空间只在「服务端密钥泄漏」后
   *   才可离线穷举；防在线爆破另有失败计数 + 锁定（service.ts）。
   */
  test('派生与比对都带密钥：拿公开的 transactionId 算不出码（10^6 空间不可离线枚举）', () => {
    const crypto = new MeetupTokenCrypto(SECRET)
    const code = crypto.deriveCode(TX)
    const storedHash = crypto.hash(code)

    // 换一把密钥（= 拖库者没有真密钥）算出的码与哈希都对不上库里的值
    const attacker = new MeetupTokenCrypto(OTHER_SECRET)
    expect(attacker.deriveCode(TX)).not.toBe(code)
    expect(attacker.hash(code)).not.toBe(storedHash)

    // 不是「公开输入的裸哈希」：无密钥者按最直白的公式（sha256(标签:id) 截断）算不出这枚码
    const unkeyed = new Bun.CryptoHasher('sha256')
    unkeyed.update(`code:${TX}`)
    const naive = String(
      Number.parseInt(unkeyed.digest('hex').slice(0, 8), 16) % 1_000_000,
    ).padStart(6, '0')
    expect(code).not.toBe(naive)

    // 比对列同理：裸 SHA-256(code) 能被人拿着库离线穷举 10^6，带密钥的 HMAC 不能
    const unkeyedHash = new Bun.CryptoHasher('sha256')
    unkeyedHash.update(code)
    expect(storedHash).not.toBe(unkeyedHash.digest('hex'))
    // 明文码不在库里：库里的列是 HMAC，而不是 6 位码本身
    expect(storedHash).not.toBe(code)
    expect(storedHash).toMatch(/^[0-9a-f]{64}$/)
  })
})
