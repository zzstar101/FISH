import { isIP } from 'node:net'

/**
 * 解析真实客户端 IP（#197 建票限流用）。
 *
 * 生产拓扑是「Caddy 在本机反代 `127.0.0.1:3000`」（`docs/deployment.md` §0）：
 * - 反代场景下 TCP peer **恒为回环地址**。若直接拿 peer 当限流 key，所有用户会共用一个桶——
 *   一个匿名者每分钟发 10 次就能把**所有人**的扫码登录锁死。
 * - Caddy 的 `reverse_proxy` 会把它看到的客户端地址**追加**到 `X-Forwarded-For` 末尾，
 *   所以回环 peer 下取 XFF **最右侧**的合法 IP 是可信的：客户端自己伪造的前缀会被追加的
 *   真实值盖在后面。
 * - peer **不是**回环地址时（本机直连、测试、或将来换部署）一律用 peer，完全忽略 XFF——
 *   否则一行 header 就能绕过限流。
 *
 * 已知局限：反代若不在本机（peer 非回环），本函数会退化成「所有请求同一个 key」。那种部署
 * 必须把反代地址纳入受信范围，当前的单机 Caddy 拓扑不需要。
 */
export function resolveClientIp(deps: {
  /** `Bun.serve` 的 `server.requestIP(request)?.address`。 */
  peerAddress: string | null
  /** 请求头 `x-forwarded-for` 原值。 */
  forwardedFor: string | null
}): string {
  const peer = deps.peerAddress?.trim()
  if (!peer) return 'unknown'
  if (!isLoopback(peer)) return peer

  // **只看最右侧那一项**：Caddy 把它看到的客户端地址追加在末尾，客户端伪造的前缀一定落在左边。
  // 绝不因为最右侧不合法就继续往左找——那等于把伪造值当成来源（换个前缀就能绕过限流）。
  const rightmost = (deps.forwardedFor ?? '').split(',').at(-1)?.trim() ?? ''
  if (rightmost !== '' && isIP(rightmost) !== 0) return rightmost
  // 最右侧不是合法 IP：退回 peer。此时限流退化为单桶，但绝不采用任何客户端可控的值。
  return peer
}

function isLoopback(address: string): boolean {
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    // 127.0.0.0/8 整段都是回环。
    /^127\./.test(address)
  )
}

// 校验用 `node:net` 的 `isIP`（纯函数，不是 Node 适配层）：手写正则判 IPv6 容易漏，
// 例如 `dead:beef:cafe:babe:face:feed:deaf:fade` 这种全是字母的地址就会被误判成非法。
