import type { MediaMessageInput } from '@fish/contracts/chat/schema'
import { type SQL, sql } from 'drizzle-orm'

/**
 * #67 发送幂等键：客户端请求标识 + 请求内容指纹。
 *
 * 落到 `messages.client_request_id` / `messages.client_request_hash`，由部分唯一索引
 * `messages_sender_conversation_client_request_uq` 保证「同一发送者在同一会话里对同一标识
 * 只落一条消息」；指纹用来区分**重试**（同键同内容 → 返回既有消息）与**幂等键复用**
 * （同键不同内容 → 409）。
 */
export interface MessageSendKey {
  clientRequestId: string
  requestHash: string
}

/**
 * 同一个 `clientRequestId` 携带了不同内容。
 *
 * 服务端**拒绝**而不是静默返回旧消息：调用方若以为新内容已送达，就会丢消息。
 * 由 service 映射为 409 `IDEMPOTENCY_KEY_REUSED`。
 */
export class MessageIdempotencyConflictError extends Error {
  constructor(readonly clientRequestId: string) {
    super('同一个 clientRequestId 不能用于内容不同的消息')
    this.name = 'MessageIdempotencyConflictError'
  }
}

const sha256Hex = (value: string): string =>
  new Bun.CryptoHasher('sha256').update(value).digest('hex')

/** NUL 分隔固定字段顺序：内容里出现分隔符也不会造成字段边界歧义。 */
const join = (parts: readonly string[]): string => parts.join('\u0000')

/** TEXT 的指纹即 trim 后的正文（与落库的 `content` 同一值）。 */
export function textRequestHash(content: string): string {
  return sha256Hex(join(['text', content]))
}

/**
 * MEDIA 指纹基于**客户端预签名 key**（重试时不变）与声明的元数据。
 *
 * 服务端写入的快照 key 每次重试都会新生成，不能参与指纹，否则同一请求的两次尝试
 * 会算出不同指纹而被误判为「幂等键复用」。
 */
export function mediaRequestHash(input: MediaMessageInput): string {
  const parts =
    input.kind === 'IMAGE'
      ? [
          'image',
          input.objectKey,
          input.contentType,
          String(input.sizeBytes),
          String(input.width),
          String(input.height),
        ]
      : [
          'voice',
          input.objectKey,
          input.contentType,
          String(input.sizeBytes),
          String(input.durationMs),
        ]
  return sha256Hex(join(parts))
}

/**
 * UUID 的规范形式（小写）。
 *
 * Pg 的 `uuid` 类型把大小写两种文本表示当成**同一个值**，路由的 `UUID_PATTERN` 也带 `/i`
 * 接受大写；但 `client_request_id` 是 **text** 列，advisory lock 的输入更是普通字符串。
 * 不统一规范化就会出现「数据库认为是同一条、锁却认为是两把」的错位：两个同发送者、同
 * requestId 的并发请求分别用大写/小写路径取得不同的锁，各自查重未命中，最后争用同一
 * 唯一索引 —— 其中一个以 23505/500 失败，而不是按承诺重放既有消息或返回 409（#67 R11）。
 *
 * 锁键、查重与落库值因此统一走这里，与 uuid 列的大小写等价规则保持一致。
 */
export function canonicalUuid(value: string): string {
  return value.toLowerCase()
}

/** 只有客户端携带了 `clientRequestId` 才启用幂等；旧客户端（缺省）退化为非幂等发送。 */
export function messageSendKey(
  clientRequestId: string | undefined,
  requestHash: string,
): MessageSendKey | null {
  // 键在构造时就规范化：查重是 text 比较，落库值也必须是规范形式，否则同键的两次尝试
  // 会被当成两个不同的键而各落一行。
  return clientRequestId ? { clientRequestId: canonicalUuid(clientRequestId), requestHash } : null
}

/**
 * 幂等键上的**事务级** advisory lock（随提交/回滚自动释放，连接池安全）。
 *
 * 为什么需要它：只用「SELECT 查重 → INSERT」在 READ COMMITTED 下挡不住两个并发的同键请求
 * （都查不到、都插入，后者撞唯一索引报 500）。拿到锁后再查重，第二个事务会阻塞到第一个
 * 提交，然后基于新快照读到那行并走「返回既有消息」路径。
 *
 * 碰撞（不同键哈希相同）只会让两个无关请求串行，不影响正确性。
 */
export function sendKeyLockQuery(
  conversationId: string,
  senderId: string,
  clientRequestId: string,
): SQL {
  // 三个分量都按 UUID 规范形式拼键。会话/发送者列是 uuid（大小写等价），client_request_id
  // 是 text（落库前已规范化），三者必须与部分唯一索引的等价规则完全一致。
  const key = [
    'chat-send',
    canonicalUuid(conversationId),
    canonicalUuid(senderId),
    canonicalUuid(clientRequestId),
  ].join(':')
  return sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
}
