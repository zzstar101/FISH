/**
 * 面交二维码 payload 的唯一构造/解析出口（#70）。
 *
 * `MeetupTokenResponse.qrPayload` 在契约里刻意是**不透明字符串**（schema 只约束
 * 非空），但 API 与小程序必须对同一格式达成一致：API 负责 build（签发响应），
 * 小程序负责 parse（扫码页拿到 `ScanResult.rawValue` 后交给 meetup 页消费）。
 * 两端都从本模块取实现，避免格式漂移。
 *
 * 格式：`fish://meetup/redeem?tx=<transactionId>&t=<token>`
 * - 携带 transactionId：扫码端无需页面上下文即可定位交易（redeem 路由的 `:id`
 *   由 payload 提供）；**token 才是凭证**，transactionId 只是地址（#70 设计原则：
 *   不把 transactionId 当作可完成凭证）。
 * - token 是 128 位**密钥派生**串的 base64url（#175），出现在 `t` 参数里 —— 截图/转发由
 *   一次性消费 + 交易进终态同事务销毁兜底，不靠 URL 保密。
 */

import { TransactionIdSchema } from '../system/public-id'

const PAYLOAD_PREFIX = 'fish://meetup/redeem'

/** 扫码 URL 只包含规范 txn_ ID，不暴露内部 UUID。 */
const validTransactionId = (value: string) => TransactionIdSchema.safeParse(value).success

/** token 字符集 = base64url（`-`/`_`/字母数字），与签发侧生成逻辑对齐。 */
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/

export function buildMeetupQrPayload(transactionId: string, token: string): string {
  if (!validTransactionId(transactionId)) {
    throw new Error(`buildMeetupQrPayload: transactionId 不是规范 txn_ ID：${transactionId}`)
  }
  if (!TOKEN_RE.test(token)) {
    throw new Error('buildMeetupQrPayload: token 含非法字符（仅允许 base64url）')
  }
  return `${PAYLOAD_PREFIX}?tx=${transactionId}&t=${token}`
}

export type MeetupQrPayload = { transactionId: string; token: string }

/** 不是本应用的 payload、或字段畸形时返回 null（调用方据此走「无效码」分支）。 */
export function parseMeetupQrPayload(payload: string): MeetupQrPayload | null {
  if (!payload.startsWith(`${PAYLOAD_PREFIX}?tx=`)) return null
  // 非 https 的自定义 scheme 没有 origin（WHATWG 返回 "null" 字符串），用 host 判定。
  const url = new URL(payload)
  if (url.protocol !== 'fish:' || url.host !== 'meetup' || url.pathname !== '/redeem') return null
  const transactionId = url.searchParams.get('tx') ?? ''
  const token = url.searchParams.get('t') ?? ''
  if (!validTransactionId(transactionId) || !TOKEN_RE.test(token)) return null
  return { transactionId, token }
}
