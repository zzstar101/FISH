/**
 * UUIDv4 生成器（Issue #323 R1 §3.7）。
 *
 * **为什么不直接用 `crypto.randomUUID()`**：那是 WebCrypto 的 API，小程序运行时里没有
 * `crypto` 这个全局对象，直接调用会在真机上抛错。而埋点的 `eventId`（幂等键：入队即固定、
 * 重试复用）与匿名会话标识都必须是 UUIDv4 —— 服务端契约用 `z.uuid()` 收口，格式不对就是 422。
 *
 * 随机性口径：只需要「撞号概率可忽略」，不需要密码学强度（这个 id 不上屏、不参与鉴权）。
 * 所以优先用宿主提供的 `getRandomValues`，拿不到才退 `Math.random()`。
 */
import Taro from '@tarojs/taro'

/** 宿主可能提供的随机源；各家签名不同，所以只按「有没有这个方法」探测 */
type RandomValuesHost = {
  getRandomValues?: (bytes: Uint8Array) => unknown
}

/**
 * UUID 的**形状**（不校验版本号）：与服务端 `z.uuid()` 的接受范围一致即可。
 * 客户端只用它做入队前的自检与本地存储的防脏，真正的收口在服务端契约校验。
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuidShaped(value: string): boolean {
  return UUID_SHAPE.test(value)
}

/**
 * 让宿主把 16 个随机字节写进 `bytes`；成功返回 true。
 *
 * 为什么写完还要检查「是不是全零」：小程序里 `wx.getRandomValues` 其实是**回调式** API
 * （参数形如 `{ length, success }`），传一个 Uint8Array 进去既不报错也不写任何字节。
 * 不做这层检查，每次生成的 id 都会是同一串全零 —— 服务端按 `event_id` 去重，
 * 后面所有事件都会被判成 duplicates 丢掉。
 */
function fillFromHost(bytes: Uint8Array): boolean {
  const hosts: RandomValuesHost[] = [Taro as unknown as RandomValuesHost]
  const wxHost = (globalThis as { wx?: RandomValuesHost }).wx
  if (wxHost) hosts.push(wxHost)
  for (const host of hosts) {
    if (typeof host.getRandomValues !== 'function') continue
    try {
      host.getRandomValues(bytes)
      if (!bytes.some((byte) => byte !== 0)) continue
      return true
    } catch {
      /* 宿主不接受这种签名，继续降级 */
    }
  }
  return false
}

/**
 * 生成一个 UUIDv4 字符串。
 *
 * 版本位（第 7 字节高 4 位 = 0100）与变体位（第 9 字节高 2 位 = 10）按 RFC 4122 写死：
 * 这两个位是「它是不是一个合法 UUIDv4」的判据，写错会被契约的 `z.uuid()` 拒掉。
 */
export function randomUuidV4(): string {
  const bytes = new Uint8Array(16)
  if (!fillFromHost(bytes)) {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80

  const hex: string[] = []
  for (let index = 0; index < bytes.length; index += 1) {
    hex.push((bytes[index] ?? 0).toString(16).padStart(2, '0'))
  }
  const joined = hex.join('')
  return [
    joined.slice(0, 8),
    joined.slice(8, 12),
    joined.slice(12, 16),
    joined.slice(16, 20),
    joined.slice(20, 32),
  ].join('-')
}
