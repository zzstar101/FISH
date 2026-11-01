import { fromUUID } from 'typeid-js'

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
  /** 交易评价（#195 PR2）。资源是 (我, 交易) 这条边，评价行本身也有公开 ID。 */
  review: 'rvw',
  notification: 'ntf',
  report: 'rpt',
  /** 交易争议（#465）。与举报共享「处理结果」，但状态机、附件与证据关联是争议域独有的。 */
  dispute: 'dsp',
  /** 意见反馈（#463）。 */
  feedback: 'fbk',
  userRestriction: 'rst',
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
  // 带上出错的 uuid：本地 seed / 手写演示数据用 v4 或非规范 UUID 时，服务端只会把它包成
  // 500 INTERNAL_ERROR（#406 第 4 项），日志里必须能看出是哪一个值违约。
  if (!UUID_V7.test(uuid)) throw new Error(`Public ID 只能编码规范 UUIDv7：${JSON.stringify(uuid)}`)
  // 用无装箱的 `fromUUID`：`TypeID` 类的构造会再解码一遍校验，而那条路径依赖 `TextEncoder`
  // （见下方 `suffixToUuid` 的说明），微信小程序真机上不存在。
  return fromUUID(uuid, prefix) as PublicId<P>
}

export function decodePublicId<P extends PublicIdPrefix>(prefix: P, id: string): string {
  if (!id.startsWith(`${prefix}_`) || id.length !== prefix.length + 27) {
    throw new Error('Public ID 的资源类型或长度不合法')
  }
  const uuid = suffixToUuid(id.slice(prefix.length + 1))
  if (uuid === null) throw new Error('Public ID 编码不合法')
  if (!UUID_V7.test(uuid) || fromUUID(uuid, prefix) !== id) {
    throw new Error('Public ID 不是规范 UUIDv7 编码')
  }
  return uuid
}

const TYPEID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

/**
 * TypeID 后缀（26 位 Crockford base32，130 bit，高 2 bit 必须为 0）→ UUID 字符串。
 *
 * 不用 typeid-js 的 `fromString`：它的解码靠 `TextEncoder`，而**微信小程序真机** JS 运行时
 * 没有这个全局（开发者工具模拟器有），真机上每个 Public ID 都会校验失败
 * （契约报「需要规范的 usr_ Public ID」，登录与列表全挂）。无装箱的编码函数 `fromUUID` 不依赖它，
 * 所以规范性仍由「解码后再编码必须原样相等」兜住。
 */
function suffixToUuid(suffix: string): string | null {
  if (suffix.length !== 26) return null
  const bytes: number[] = []
  let acc = 0
  let bits = 0
  for (let i = 0; i < 26; i += 1) {
    const value = TYPEID_ALPHABET.indexOf(suffix.charAt(i))
    if (value < 0) return null
    if (i === 0) {
      // 首位只承载 3 bit（130 - 128 = 2 bit 填充）：大于 7 就溢出 128 bit
      if (value > 7) return null
      acc = value
      bits = 3
      continue
    }
    acc = ((acc << 5) | value) & 0x1fff
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((acc >> bits) & 0xff)
    }
  }
  if (bytes.length !== 16) return null
  const hex = bytes.map((byte) => `0${byte.toString(16)}`.slice(-2)).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
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
