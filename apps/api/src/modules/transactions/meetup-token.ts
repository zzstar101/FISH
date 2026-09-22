import { buildMeetupQrPayload } from '@fish/contracts/transactions/meetup-qr'

/**
 * 面交凭证的派生与哈希（#70；#175 改为确定性派生）。唯一的安全口径：
 * - 6 位码与 QR token 都由服务端密钥**确定性派生**：`HMAC(secret, "<标签>:<交易id>")`。
 *   同一笔交易任何时候算出来都是同一枚 —— 卖家反复进页面读到的码不变（#175 一单一码），
 *   因此不需要在库里存明文，也不需要「重签」来重放。
 * - 明文仍**不落库**：DB 只存这两枚明文的 HMAC-SHA256（hex），拖库者没有密钥既算不出
 *   派生值、也无法从哈希反推。
 * - 派生与哈希都必须带服务端密钥（MEETUP_TOKEN_SECRET），不能裸 SHA-256：否则
 *   公开的 transactionId 一算就是码，10^6 的码空间（以及 QR token）等于没有。
 * - 6 位码空间小，防爆破靠服务层的失败计数 + 锁定（service.ts）。
 */
export class MeetupTokenCrypto {
  private readonly secret: string
  private readonly hasher: (value: string) => string

  constructor(secret: string) {
    this.secret = secret
    this.hasher = (value: string) => {
      const hasher = new Bun.CryptoHasher('sha256', secret)
      hasher.update(value)
      return hasher.digest('hex')
    }
  }

  hash(value: string): string {
    return this.hasher(value)
  }

  /**
   * 派生原始摘要（hex）。标签把「6 位码」与「QR token」两个域分开：同一个交易 id 在
   * 两个标签下的输出互不可推，码不会等于 token 的某个前缀。
   */
  private deriveHex(transactionId: string, label: 'code' | 'qr'): string {
    const hasher = new Bun.CryptoHasher('sha256', this.secret)
    hasher.update(`${label}:${transactionId}`)
    return hasher.digest('hex')
  }

  /** 6 位数字码（000000–999999），首尾可 0 —— 与输入框的 6 格语义一致。 */
  deriveCode(transactionId: string): string {
    const value = Number.parseInt(this.deriveHex(transactionId, 'code').slice(0, 8), 16)
    // 2^32 对 10^6 有取整偏差（相对偏差 ~1e-5 量级）：只影响各位数字的分布，
    // 码空间仍为 10^6，防爆破依赖失败锁定而非分布均匀性。
    return String(value % 1_000_000).padStart(6, '0')
  }

  /** 摘要前 16 字节 → 22 位 base64url（`-`/`_` 安全出现在 URL query，无需再编码）。 */
  deriveToken(transactionId: string): string {
    return Buffer.from(this.deriveHex(transactionId, 'qr').slice(0, 32), 'hex').toString(
      'base64url',
    )
  }

  qrPayload(transactionId: string, token: string): string {
    return buildMeetupQrPayload(transactionId, token)
  }
}
