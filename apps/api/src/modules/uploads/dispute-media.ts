import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto'
import type { ALLOWED_IMAGE_MIME } from '@fish/contracts/listings/schema'
import {
  decodePublicId,
  encodePublicId,
  isPublicId,
  PUBLIC_ID_PREFIX,
} from '@fish/shared/public-id'

/**
 * #465：交易争议附件的私有前缀、键形状与短期读取令牌。
 *
 * 争议附件是**受限图片**：只有发起人、被诉方与管理员能看。部署策略（`infra/minio-public-policy.json`）
 * 只放开了 `listings/*` 给匿名读，所以把附件写到 `dispute-media/` 下就天然不可匿名读、不可列举 ——
 * 不需要新桶，也不需要改桶策略。
 *
 * 那前端怎么显示？与 #286 审核中图片同一手法：一个**短期** capability URL。
 * 对象键加密进 URL，明文里带过期时刻，因此
 *   - URL 里没有对象键，也没有裸 UUID（不泄露存储布局）；
 *   - 令牌是 secret 派生的 AES-GCM 密文，猜不出来；
 *   - `exp` 在密文内且参与重算校验，改不了；
 *   - 过期即失效，不需要额外的黑名单。
 *
 * 也刻意**不挂 session 鉴权**（同 review-media）：小程序原生 `<Image>` 不带 cookie，
 * 授权载体是这个不可猜、会过期、不泄露 objectKey 的 URL 本身。
 *
 * 键形状与令牌放在同一个文件里是为了打断模块环：`storage.ts` 需要「私有键 → 签名地址」，
 * 而签名必须校验键形状（安全边界），两者放一起就只剩 `storage.ts → dispute-media.ts` 单向依赖。
 *
 * 键形状：`dispute-media/{dsp_<disputeId>}/{usr_<uploaderId>}/{med_<attachmentId>}.{ext}`
 * —— 三段都是规范 TypeID。第三段**就是附件行主键**，因此确认接口能从对象键解出行 id，
 * 天然幂等，也不需要额外的「上传会话」表。
 */

export const DISPUTE_MEDIA_PREFIX = 'dispute-media/'

const DISPUTE_MEDIA_KEY = /^dispute-media\/([^/]+)\/([^/]+)\/([^/.]+)\.(jpg|png|webp)$/

/** 扩展名 ↔ mime 的映射只在这里出现一次（客户端给 mime，扩展名由服务端推导）。 */
const EXTENSION_BY_MIME: Record<(typeof ALLOWED_IMAGE_MIME)[number], 'jpg' | 'png' | 'webp'> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

const MIME_BY_EXTENSION: Record<'jpg' | 'png' | 'webp', (typeof ALLOWED_IMAGE_MIME)[number]> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

export type DisputeMediaParts = {
  disputeId: string
  uploaderId: string
  attachmentId: string
  mimeType: (typeof ALLOWED_IMAGE_MIME)[number]
}

/** 争议附件在对象存储里的归属前缀。归属校验靠键里的 disputeId + uploaderId，不需要登记表。 */
export function disputeMediaPrefix(disputeId: string, uploaderId: string): string {
  return `${DISPUTE_MEDIA_PREFIX}${encodePublicId(PUBLIC_ID_PREFIX.dispute, disputeId)}/${encodePublicId(PUBLIC_ID_PREFIX.user, uploaderId)}/`
}

/** 生成附件对象键。`attachmentId` 是预先分配好的 UUIDv7（确认时它成为附件行主键）。 */
export function disputeMediaObjectKey(
  disputeId: string,
  uploaderId: string,
  attachmentId: string,
  contentType: (typeof ALLOWED_IMAGE_MIME)[number],
): string {
  const id = encodePublicId(PUBLIC_ID_PREFIX.media, attachmentId)
  return `${disputeMediaPrefix(disputeId, uploaderId)}${id}.${EXTENSION_BY_MIME[contentType]}`
}

/** 解析键形状；非本前缀或任一段不是规范 TypeID 时返回 `null`。 */
export function parseDisputeMediaKey(key: string): DisputeMediaParts | null {
  const match = DISPUTE_MEDIA_KEY.exec(key)
  if (!match) return null
  const [, disputeId, uploaderId, attachmentId, extension] = match
  if (
    !isPublicId(PUBLIC_ID_PREFIX.dispute, disputeId) ||
    !isPublicId(PUBLIC_ID_PREFIX.user, uploaderId) ||
    !isPublicId(PUBLIC_ID_PREFIX.media, attachmentId)
  ) {
    return null
  }
  try {
    return {
      disputeId: decodePublicId(PUBLIC_ID_PREFIX.dispute, disputeId),
      uploaderId: decodePublicId(PUBLIC_ID_PREFIX.user, uploaderId),
      attachmentId: decodePublicId(PUBLIC_ID_PREFIX.media, attachmentId),
      mimeType: MIME_BY_EXTENSION[extension as 'jpg' | 'png' | 'webp'],
    }
  } catch {
    return null
  }
}

export function isDisputeMediaKey(key: string): boolean {
  return parseDisputeMediaKey(key) !== null
}

/**
 * 读取地址有效期：15 分钟，与审核中图片一致。比 `Cache-Control: private, max-age=300` 长，
 * 但远短于一次人工巡检（管理端刷新页面就会拿到新地址）。
 */
export const DISPUTE_MEDIA_URL_TTL_SECONDS = 900

const TOKEN = /^[A-Za-z0-9_-]{20,400}$/

/** 附件摘要格式（小写 hex sha256）；行上的 CHECK 与令牌里的密文用同一形状。 */
export const SHA256_HEX = /^[0-9a-f]{64}$/

/**
 * 字节摘要的唯一实现：写入侧（confirm 落库）与读取侧（代理核对）必须算出同一个值，
 * 所以只留这一处。`SHA256_HEX` 是它的输出形状。
 */
export function contentDigestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function keyFromSecret(secret: string): Buffer {
  // 与审核中图片代理、旧媒体代理、面交二维码签名各自独立：同一个部署 secret 派生不同用途的密钥。
  return createHash('sha256').update('fish465:dispute-media:v1:').update(secret).digest()
}

/**
 * 短期读取令牌。同一个键 + 同一个过期秒 + 同一个 digest → 同一个令牌（确定性 nonce），
 * 因此同一秒内的响应可以命中缓存，而不是每次刷新换一个 URL。
 *
 * `contentDigest` 是确认时刻存进行里的 sha256，**放进密文**：读代理据此拒绝下发
 * 已被替换过的对象。没有它，「证据不可被覆盖替换」只是句空话 —— 预签名 URL 在
 * 有效期内仍可对同一 key 二次 PUT。
 */
export function disputeMediaToken(
  key: string,
  secret: string,
  expiresAtSeconds: number,
  contentDigest: string,
): string {
  if (!isDisputeMediaKey(key)) throw new Error('非争议附件对象键')
  if (!Number.isInteger(expiresAtSeconds) || expiresAtSeconds <= 0)
    throw new Error('过期时刻不合法')
  if (!SHA256_HEX.test(contentDigest)) throw new Error('附件摘要不合法')
  const encryptionKey = keyFromSecret(secret)
  const payload = `${expiresAtSeconds}\n${contentDigest}\n${key}`
  const nonce = createHmac('sha256', encryptionKey).update(payload).digest().subarray(0, 12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce)
  const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()])
  return Buffer.concat([nonce, encrypted, cipher.getAuthTag()]).toString('base64url')
}

/** 令牌比较用常量时间：长度由格式决定、不是秘密，等长时再逐字节比。 */
function tokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

/** 令牌解出的内容：对象键 + 确认时刻固化的字节摘要。 */
export type DisputeMediaTicket = { key: string; contentDigest: string }

/** 校验并解出对象键与摘要；过期、伪造、键形状不符一律返回 `null`（调用方 404）。 */
export function disputeMediaKey(
  token: string,
  secret: string,
  nowSeconds: number,
): DisputeMediaTicket | null {
  if (!TOKEN.test(token)) return null
  try {
    const bytes = Buffer.from(token, 'base64url')
    // 非规范 base64url 与长度越界直接拒掉，别让解密路径吃奇怪输入。
    if (bytes.toString('base64url') !== token || bytes.length < 30 || bytes.length > 400)
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
    const digestSeparator = payload.indexOf('\n', separator + 1)
    if (digestSeparator <= 0) return null
    const expiresAtSeconds = Number(payload.slice(0, separator))
    const contentDigest = payload.slice(separator + 1, digestSeparator)
    const key = payload.slice(digestSeparator + 1)
    if (!Number.isInteger(expiresAtSeconds) || expiresAtSeconds <= nowSeconds) return null
    // 重算令牌：拒掉非规范 nonce / 被改过的密文，且顺带保证键形状与摘要形状合法。
    if (
      !isDisputeMediaKey(key) ||
      !SHA256_HEX.test(contentDigest) ||
      !tokensEqual(disputeMediaToken(key, secret, expiresAtSeconds, contentDigest), token)
    ) {
      return null
    }
    return { key, contentDigest }
  } catch {
    return null
  }
}
