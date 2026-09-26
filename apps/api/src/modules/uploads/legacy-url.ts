import { createCipheriv, createDecipheriv, createHash, createHmac } from 'node:crypto'

// Historical objects are retained under UUID-named keys. Never put these keys in a public URL.
const LEGACY_LISTING_KEY =
  /^listings\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/[A-Za-z0-9_-]+\.(?:jpg|png|webp)$/
const TOKEN = /^[A-Za-z0-9_-]{20,400}$/

export function isLegacyListingKey(key: string): boolean {
  return LEGACY_LISTING_KEY.test(key)
}

function keyFromSecret(secret: string): Buffer {
  // Separate this encryption key from the meeting QR signature's key and purpose.
  return createHash('sha256').update('fish217:legacy-media:v1:').update(secret).digest()
}

/** Stable authenticated token, so caches can retain old images; no UUID or object key in its URL. */
export function legacyMediaToken(key: string, secret: string): string {
  if (!isLegacyListingKey(key)) throw new Error('非历史图片对象键')
  const encryptionKey = keyFromSecret(secret)
  const nonce = createHmac('sha256', encryptionKey).update(key).digest().subarray(0, 12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce)
  const encrypted = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()])
  return Buffer.concat([nonce, encrypted, cipher.getAuthTag()]).toString('base64url')
}

export function legacyMediaKey(token: string, secret: string): string | null {
  if (!TOKEN.test(token)) return null
  try {
    const bytes = Buffer.from(token, 'base64url')
    if (bytes.toString('base64url') !== token || bytes.length < 29 || bytes.length > 256)
      return null
    const nonce = bytes.subarray(0, 12)
    const tag = bytes.subarray(bytes.length - 16)
    const decipher = createDecipheriv('aes-256-gcm', keyFromSecret(secret), nonce)
    decipher.setAuthTag(tag)
    const key = Buffer.concat([
      decipher.update(bytes.subarray(12, bytes.length - 16)),
      decipher.final(),
    ]).toString('utf8')
    // Reject forged tokens that could use noncanonical nonces or point outside the legacy namespace.
    if (!isLegacyListingKey(key) || legacyMediaToken(key, secret) !== token) return null
    return key
  } catch {
    return null
  }
}
