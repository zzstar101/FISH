import { buildMeetupQrPayload } from '@fish/contracts/transactions/meetup-qr'

/**
 * 面交凭证的生成与哈希（#70）。唯一的安全口径：
 * - 6 位码与 QR token **明文只在签发响应出现一次**，DB 只存 HMAC-SHA256（hex）；
 *   拖库者拿不到可展示/可输入的码。
 * - token = 16 字节 CSPRNG 的 base64url（128 位熵），6 位码 = CSPRNG 整数补零；
 *   6 位码空间小，防爆破靠服务层的失败计数 + 锁定（service.ts）。
 * - 哈希必须带服务端密钥（MEETUP_TOKEN_SECRET），不能裸 SHA-256：否则 10^6 的
 *   码空间可被离线穷举。
 */
export class MeetupTokenCrypto {
  private readonly hasher: (value: string) => string

  constructor(secret: string) {
    this.hasher = (value: string) => {
      const hasher = new Bun.CryptoHasher('sha256', secret)
      hasher.update(value)
      return hasher.digest('hex')
    }
  }

  hash(value: string): string {
    return this.hasher(value)
  }

  /** 16 字节随机 → 22 位 base64url（`-`/`_` 安全出现在 URL query，无需再编码）。 */
  generateToken(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    return Buffer.from(bytes).toString('base64url')
  }

  /** 6 位数字码（000000–999999），首尾可 0 —— 与输入框的 6 格语义一致。 */
  generateCode(): string {
    const value = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0
    // 2^32 对 10^6 有取整偏差，但只影响各位数字的分布（<1e-6 量级），码空间不变。
    return String(value % 1_000_000).padStart(6, '0')
  }

  qrPayload(transactionId: string, token: string): string {
    return buildMeetupQrPayload(transactionId, token)
  }
}
