import { createCipheriv, createDecipheriv, createHash, createHmac } from 'node:crypto'
import { encodePublicId, isPublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'

/**
 * #286 复审 blocker 2：**审核中**图片的私有前缀与短期读取令牌。
 *
 * 背景：机器结论为 `REVIEW` 的图在人工放行前不能出现在匿名可读的位置。部署策略只放开了
 * `listings/*`（`infra/minio-public-policy.json` / `docs/deployment.md`），所以把 REVIEW 快照写到
 * 这个前缀下就天然不可匿名读；商品不进公开 Feed **不能**替代对象级访问控制 —— 上传者拿到直链
 * 仍可主动分享。
 *
 * 那审核队列（管理员看商品图）与卖家自己的「我发布的」怎么显示这张图？用一个**短期**的
 * capability URL：对象键加密进 URL，明文里带过期时刻，因此
 *   - URL 里没有对象键，也没有 UUID（不会泄露存储布局）；
 *   - 令牌是 secret 派生的 AES-GCM 密文，猜不出来；
 *   - `exp` 在密文内且参与重算校验，改不了；
 *   - 过期即失效，不需要额外的黑名单。
 *
 * 键形状与令牌放在同一个文件里是为了打断模块环：`storage.ts` 需要「私有时返回签名地址」，
 * 而签名必须校验键形状（安全边界），两者放一起就只剩 `storage.ts → review-media.ts` 单向依赖。
 */

/** 私有固化前缀：服务端写入、不匿名可读，人工放行后才搬到公开的 `listings/`。 */
export const LISTING_REVIEW_MEDIA_PREFIX = 'listing-review-media/'

/** 私有键形状：`listing-review-media/{usr_…}/{med_…}.{ext}`（两段都必须是规范 TypeID）。 */
const LISTING_REVIEW_MEDIA_KEY = /^listing-review-media\/([^/]+)\/([^/.]+)\.(?:jpg|png|webp)$/

/** 与 staging 前缀同理：归属校验靠键里的 userId，不需要新增登记表。 */
export function listingReviewMediaPrefix(userId: string): string {
  return `${LISTING_REVIEW_MEDIA_PREFIX}${encodePublicId(PUBLIC_ID_PREFIX.user, userId)}/`
}

export function isListingReviewMediaKey(key: string): boolean {
  const match = LISTING_REVIEW_MEDIA_KEY.exec(key)
  return Boolean(
    match &&
      isPublicId(PUBLIC_ID_PREFIX.user, match[1]) &&
      isPublicId(PUBLIC_ID_PREFIX.media, match[2]),
  )
}

/**
 * 读取地址的有效期：15 分钟。比聊天媒体的 `Cache-Control: private, max-age=300` 长，
 * 但远短于审核队列的一次人工巡检（管理员刷新页面就会拿到新地址）。
 */
export const REVIEW_MEDIA_URL_TTL_SECONDS = 900

const TOKEN = /^[A-Za-z0-9_-]{20,400}$/

function keyFromSecret(secret: string): Buffer {
  // 与旧媒体代理、面交二维码签名各自独立：同一个部署 secret 派生不同用途的密钥。
  return createHash('sha256').update('fish286:listing-review-media:v1:').update(secret).digest()
}

/**
 * 短期读取令牌。同一个键 + 同一个过期秒 → 同一个令牌（nonce 由明文确定，与旧媒体代理同样
 * 「确定性 nonce」），因此同一秒内的响应可以命中缓存，而不是每次刷新换一个 URL。
 */
export function reviewMediaToken(key: string, secret: string, expiresAtSeconds: number): string {
  if (!isListingReviewMediaKey(key)) throw new Error('非审核图片对象键')
  if (!Number.isInteger(expiresAtSeconds) || expiresAtSeconds <= 0)
    throw new Error('过期时刻不合法')
  const encryptionKey = keyFromSecret(secret)
  const payload = `${expiresAtSeconds}\n${key}`
  const nonce = createHmac('sha256', encryptionKey).update(payload).digest().subarray(0, 12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce)
  const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()])
  return Buffer.concat([nonce, encrypted, cipher.getAuthTag()]).toString('base64url')
}

/** 校验并解出对象键；过期、伪造、键形状不符一律返回 `null`（调用方 404）。 */
export function reviewMediaKey(token: string, secret: string, nowSeconds: number): string | null {
  if (!TOKEN.test(token)) return null
  try {
    const bytes = Buffer.from(token, 'base64url')
    // 非规范 base64url 与长度越界直接拒掉，别让解密路径吃奇怪输入。
    if (bytes.toString('base64url') !== token || bytes.length < 30 || bytes.length > 384)
      return null
    const nonce = bytes.subarray(0, 12)
    const tag = bytes.subarray(bytes.length - 16)
    const decipher = createDecipheriv('aes-256-gcm', keyFromSecret(secret), nonce)
    decipher.setAuthTag(tag)
    const payload = Buffer.concat([
      decipher.update(bytes.subarray(12, bytes.length - 16)),
      decipher.final(),
    ]).toString('utf8')
    const separator = payload.indexOf('\n')
    if (separator <= 0) return null
    const expiresAtSeconds = Number(payload.slice(0, separator))
    const key = payload.slice(separator + 1)
    if (!Number.isInteger(expiresAtSeconds) || expiresAtSeconds <= nowSeconds) return null
    // 重算令牌：拒掉非规范 nonce / 被改过的密文，且顺带保证键形状合法。
    if (
      !isListingReviewMediaKey(key) ||
      reviewMediaToken(key, secret, expiresAtSeconds) !== token
    ) {
      return null
    }
    return key
  } catch {
    return null
  }
}
