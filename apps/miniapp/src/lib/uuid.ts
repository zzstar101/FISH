/**
 * 客户端请求标识（#67 第一步）：每次**新发送**生成一个，重试沿用同一个。
 *
 * 服务端按 `(sender_id, conversation_id, client_request_id)` 建了部分唯一索引，
 * 所以这个值的唯一性直接决定「重复发送会不会在库里留下第二条消息」。
 *
 * 随机源：小程序运行时通常没有 Web Crypto，`globalThis.crypto` 存在时优先用它，
 * 否则退到 `Math.random`。这里的强度要求只是「同一台设备短时间内不撞」——
 * 服务端的约束是 `(发送者, 会话, 请求标识)` 三元组，不同用户/会话之间本来就不会互相干扰。
 */
export function newClientRequestId(): string {
  const bytes = new Uint8Array(16)
  const webCrypto = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => void } })
    .crypto
  if (typeof webCrypto?.getRandomValues === 'function') {
    webCrypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  // RFC 4122 v4：版本位与变体位，契约是 `z.uuid()`，形态必须对
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
