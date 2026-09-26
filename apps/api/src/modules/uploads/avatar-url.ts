import { isLegacyListingKey, legacyMediaToken } from './legacy-url'

export type AvatarUrlConfig = {
  s3PublicUrl: string | undefined
  webOrigin: string | undefined
  secret: string | undefined
}

const UUID_IN_URL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i

/**
 * Avatar URLs predate typed object keys and are stored as absolute URLs, not object keys.
 * Re-project only URLs from our configured S3 bucket; never proxy an arbitrary external URL.
 * Unknown UUID-bearing URLs fail closed rather than exposing a possible resource ID.
 */
export function publicAvatarUrl(
  value: string | null,
  config: AvatarUrlConfig = {
    s3PublicUrl: process.env.S3_PUBLIC_URL,
    webOrigin: process.env.WEB_ORIGIN,
    secret: process.env.MEETUP_TOKEN_SECRET,
  },
): string | null {
  if (value === null) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (!UUID_IN_URL.test(`${url.pathname}${url.search}${url.hash}`)) return value
  if (!config.s3PublicUrl || !config.webOrigin || !config.secret) return null
  let bucket: URL
  try {
    bucket = new URL(config.s3PublicUrl)
  } catch {
    return null
  }
  const basePath = bucket.pathname.replace(/\/+$/, '')
  if (
    url.origin !== bucket.origin ||
    !url.pathname.startsWith(`${basePath}/`) ||
    url.search ||
    url.hash
  )
    return null
  const objectKey = url.pathname.slice(basePath.length + 1)
  if (!isLegacyListingKey(objectKey)) return null
  return `${config.webOrigin.replace(/\/+$/, '')}/api/uploads/legacy/${legacyMediaToken(objectKey, config.secret)}`
}
