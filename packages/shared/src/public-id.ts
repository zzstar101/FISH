import { TypeID } from 'typeid-js'

/** Canonical TypeID encoding at the HTTP/WS boundary; database keys remain UUIDv7. */
export const PUBLIC_ID_PREFIX = {
  user: 'usr',
  listing: 'lst',
  wish: 'wsh',
  match: 'mtc',
  conversation: 'cnv',
  message: 'msg',
  transaction: 'txn',
  comment: 'cmt',
  notification: 'ntf',
  report: 'rpt',
  media: 'med',
  moderationRecord: 'mdr',
  auditLog: 'aud',
} as const

export type PublicIdPrefix = (typeof PUBLIC_ID_PREFIX)[keyof typeof PUBLIC_ID_PREFIX]
export type PublicId<P extends PublicIdPrefix> = `${P}_${string}`

// UUID version and variant are significant: accepting a v4 UUID would make the public
// protocol silently preserve the old, incompatible primary-key generator.
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function encodePublicId<P extends PublicIdPrefix>(prefix: P, uuid: string): PublicId<P> {
  if (!UUID_V7.test(uuid)) throw new Error('Public ID 只能编码规范 UUIDv7')
  return TypeID.fromUUID(prefix, uuid).toString() as PublicId<P>
}

export function decodePublicId<P extends PublicIdPrefix>(prefix: P, id: string): string {
  if (!id.startsWith(`${prefix}_`) || id.length !== prefix.length + 27) {
    throw new Error('Public ID 的资源类型或长度不合法')
  }
  let decoded: TypeID<P>
  try {
    decoded = TypeID.fromString(id, prefix)
  } catch {
    throw new Error('Public ID 编码不合法')
  }
  const uuid = decoded.toUUID()
  if (!UUID_V7.test(uuid) || decoded.toString() !== id) {
    throw new Error('Public ID 不是规范 UUIDv7 编码')
  }
  return uuid
}

export function isPublicId<P extends PublicIdPrefix>(
  prefix: P,
  value: unknown,
): value is PublicId<P> {
  if (typeof value !== 'string') return false
  try {
    decodePublicId(prefix, value)
    return true
  } catch {
    return false
  }
}
