import { expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import {
  contentDigestOf,
  DISPUTE_MEDIA_PREFIX,
  DISPUTE_MEDIA_URL_TTL_SECONDS,
  disputeMediaKey,
  disputeMediaObjectKey,
  disputeMediaPrefix,
  disputeMediaToken,
  isDisputeMediaKey,
  parseDisputeMediaKey,
  SHA256_HEX,
} from './dispute-media'
import { reviewMediaKey, reviewMediaToken } from './review-media'

const disputeId = '01930000-0000-7000-8000-00000000000a'
const uploaderId = '01930000-0000-7000-8000-00000000000b'
const attachmentId = '01930000-0000-7000-8000-00000000000c'
const secret = 'a-secret-for-test-purposes-longer-than-32-characters'
const now = 1_800_000_000
/** 一张图的字节摘要（内容本身无关，令牌只做完整性绑定）。 */
const digest = contentDigestOf(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))

const key = disputeMediaObjectKey(disputeId, uploaderId, attachmentId, 'image/jpeg')

test('对象键形状固定为 dispute-media/{dsp}/{usr}/{med}.{ext}，扩展名由 mime 推导', () => {
  expect(DISPUTE_MEDIA_PREFIX).toBe('dispute-media/')
  expect(key).toBe(
    `dispute-media/${encodePublicId(PUBLIC_ID_PREFIX.dispute, disputeId)}/` +
      `${encodePublicId(PUBLIC_ID_PREFIX.user, uploaderId)}/` +
      `${encodePublicId(PUBLIC_ID_PREFIX.media, attachmentId)}.jpg`,
  )
  // 客户端给的 contentType 决定扩展名，反过来也必须能解析回同一个 mime。
  expect(key).not.toContain(disputeId)
  expect(key).not.toContain(uploaderId)
  expect(disputeMediaObjectKey(disputeId, uploaderId, attachmentId, 'image/png')).toEndWith('.png')
  expect(disputeMediaObjectKey(disputeId, uploaderId, attachmentId, 'image/webp')).toEndWith(
    '.webp',
  )
})

test('解析对象键能取回三段公开 ID 与 mime（附件行主键 = 第三段，天然幂等）', () => {
  expect(parseDisputeMediaKey(key)).toEqual({
    disputeId,
    uploaderId,
    attachmentId,
    mimeType: 'image/jpeg',
  })
  expect(
    parseDisputeMediaKey(disputeMediaObjectKey(disputeId, uploaderId, attachmentId, 'image/png'))
      ?.mimeType,
  ).toBe('image/png')
})

test('前缀/形状不符的对象键一律解析为 null（不接受裸 UUID 或跨前缀）', () => {
  const parts = parseDisputeMediaKey
  expect(parts('listing-media/usr_x/med_y.jpg')).toBeNull()
  expect(parts('dispute-media/not-a-typeid/usr_x/med_y.jpg')).toBeNull()
  expect(parts(`${disputeMediaPrefix(disputeId, uploaderId)}../../etc/passwd.jpg`)).toBeNull()
  expect(parts(`${disputeMediaPrefix(disputeId, uploaderId)}${attachmentId}.jpg`)).toBeNull()
  expect(
    parts(`${disputeMediaPrefix(disputeId, uploaderId)}med_01jc000000e00800000000000a.gif`),
  ).toBeNull()
  expect(isDisputeMediaKey(key)).toBe(true)
  expect(isDisputeMediaKey('listings/seed-demo/1.jpg')).toBe(false)
})

test('读取令牌可稳定解出对象键与字节摘要，且不暴露对象键或任何 UUID', () => {
  const expiresAt = now + DISPUTE_MEDIA_URL_TTL_SECONDS
  const token = disputeMediaToken(key, secret, expiresAt, digest)
  expect(token).toBe(disputeMediaToken(key, secret, expiresAt, digest))
  expect(token).not.toContain('dispute-media')
  expect(token).not.toContain(disputeId)
  expect(token).not.toContain(uploaderId)
  expect(token).not.toContain(attachmentId)
  // 摘要本身也编码在令牌里（读侧要拿它比对实际字节），但令牌不是明文载体。
  expect(token).not.toContain(digest)
  expect(disputeMediaKey(token, secret, now)).toEqual({ key, contentDigest: digest })
  expect(disputeMediaKey(token, `${secret}wrong`, now)).toBeNull()
  expect(disputeMediaKey(`${token.slice(0, -1)}!`, secret, now)).toBeNull()
  expect(disputeMediaKey(Buffer.from(key).toString('base64url'), secret, now)).toBeNull()
})

test('令牌与摘要绑定：换一个摘要就是另一个令牌，旧令牌解出的仍是旧摘要', () => {
  const expiresAt = now + DISPUTE_MEDIA_URL_TTL_SECONDS
  const other = contentDigestOf(new Uint8Array([1, 2, 3]))
  expect(disputeMediaToken(key, secret, expiresAt, other)).not.toBe(
    disputeMediaToken(key, secret, expiresAt, digest),
  )
  // 摘要不合法（不是 64 位小写 hex）直接拒绝签发，避免读侧拿不到可比对的值。
  expect(() => disputeMediaToken(key, secret, expiresAt, 'not-a-digest')).toThrow('附件摘要不合法')
  expect(() => disputeMediaToken(key, secret, expiresAt, digest.toUpperCase())).toThrow(
    '附件摘要不合法',
  )
})

test('contentDigestOf 是纯 sha256 hex（写入侧与读取侧共用同一个实现）', () => {
  // 空字节的 sha256 是公认常量，用它锁住「算法 + 编码」不会被人悄悄换掉。
  expect(contentDigestOf(new Uint8Array([]))).toBe(
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  )
  expect(SHA256_HEX.test(contentDigestOf(new Uint8Array([1, 2, 3])))).toBe(true)
})

test('令牌到期即失效，有效期常量与缓存策略一致（300s 缓存 < 900s TTL）', () => {
  expect(DISPUTE_MEDIA_URL_TTL_SECONDS).toBe(900)
  const expiresAt = now + DISPUTE_MEDIA_URL_TTL_SECONDS
  const token = disputeMediaToken(key, secret, expiresAt, digest)
  expect(disputeMediaKey(token, secret, expiresAt - 1)).toEqual({ key, contentDigest: digest })
  expect(disputeMediaKey(token, secret, expiresAt)).toBeNull()
  expect(disputeMediaKey(token, secret, expiresAt + 1)).toBeNull()
})

test('用途派生串独立：争议附件的令牌不能当审核中图片的令牌用（反之亦然）', () => {
  const expiresAt = now + DISPUTE_MEDIA_URL_TTL_SECONDS
  const disputeToken = disputeMediaToken(key, secret, expiresAt, digest)
  expect(reviewMediaKey(disputeToken, secret, now)).toBeNull()

  const reviewKey = `listing-review-media/${encodePublicId(PUBLIC_ID_PREFIX.user, uploaderId)}/${encodePublicId(
    PUBLIC_ID_PREFIX.media,
    attachmentId,
  )}.jpg`
  expect(disputeMediaKey(reviewMediaToken(reviewKey, secret, expiresAt), secret, now)).toBeNull()
})

test('畸形令牌一律拒绝，不进入解密路径', () => {
  expect(disputeMediaKey('', secret, now)).toBeNull()
  expect(disputeMediaKey('!!!!', secret, now)).toBeNull()
  expect(disputeMediaKey('a'.repeat(19), secret, now)).toBeNull()
  expect(disputeMediaKey('a'.repeat(401), secret, now)).toBeNull()
})
