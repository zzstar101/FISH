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

/**
 * 手动解析 `a=1&b=2`，读取口径对齐 `URLSearchParams`：同名参数取**第一个**、
 * `+` 视作空格、百分号转义解码。
 *
 * **不用 `new URL` / `URLSearchParams`**（#536）：小程序 weapp 构建里 Taro 用
 * ProvidePlugin 把这两个全局换成 `@tarojs/runtime` 的实现，其 `parseUrlBase`
 * 只接受 `http(s)://`，对 `fish://…` 构造即抛 `TypeError: Invalid URL`。
 * 异常曾落在扫码回调里、任何状态更新之前，导致扫码静默中断（取景框停住、无核销请求）。
 * 本解析器不依赖任何运行时 URL 全局。
 */
function parseQuery(query: string): Map<string, string> {
  const params = new Map<string, string>()
  for (const part of query.split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const rawKey = eq === -1 ? part : part.slice(0, eq)
    const rawValue = eq === -1 ? '' : part.slice(eq + 1)
    const key = decodeURIComponent(rawKey.replace(/\+/g, ' '))
    if (params.has(key)) continue
    params.set(key, decodeURIComponent(rawValue.replace(/\+/g, ' ')))
  }
  return params
}

/**
 * 不是本应用的 payload、或字段畸形时返回 null（调用方据此走「无效码」分支）。
 *
 * **全量函数**：任何输入都不抛（畸形百分号转义等交给 catch 收敛成 null）。
 * 扫码回调没有外层 try/catch，抛异常会让用户看到"扫不动"且没有任何反馈（#536）。
 */
export function parseMeetupQrPayload(payload: string): MeetupQrPayload | null {
  try {
    const prefix = `${PAYLOAD_PREFIX}?`
    if (!payload.startsWith(prefix)) return null
    // 与 WHATWG URL 对齐：fragment 不参与查询（本应用签发的 payload 也不带 fragment）。
    const hashAt = payload.indexOf('#')
    const query = (hashAt === -1 ? payload : payload.slice(0, hashAt)).slice(prefix.length)
    const params = parseQuery(query)
    const transactionId = params.get('tx') ?? ''
    const token = params.get('t') ?? ''
    if (!validTransactionId(transactionId) || !TOKEN_RE.test(token)) return null
    return { transactionId, token }
  } catch {
    return null
  }
}
