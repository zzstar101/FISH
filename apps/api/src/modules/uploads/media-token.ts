import { timingSafeEqual } from 'node:crypto'

/**
 * 私有媒体读取令牌的形状：base64url 密文、长度有界。
 *
 * 三个代理 —— `legacy-url`（历史图片）、`review-media`（审核中图片）、`dispute-media`
 * （争议附件，本 PR 新增）—— 的令牌都是 `nonce || ciphertext || authTag` 的 base64url，
 * 形状完全一致，所以只留这一处。这是拒绝非法输入的**第一道闸**，三份各自漂移不会立刻有
 * 测试报错（下游还有解密与重算兜底），所以尤其不该复制。
 */
export const MEDIA_TOKEN = /^[A-Za-z0-9_-]{20,400}$/

/**
 * 令牌比较用常量时间：长度由格式决定、不是秘密，等长时再逐字节比。
 *
 * 读取路径要「重算令牌再比对」，用来拒掉非规范 nonce / 被改过的密文；字符串 `===`
 * 会在首个不同字节短路，给攻击者一个逐字节试探的时间侧信道。
 */
export function tokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}
