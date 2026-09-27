/**
 * 共用微信 `access_token` 服务（#294）。
 *
 * 手机号 live resolver（#204）与 Web 扫码登录（#197）都要用 access_token，而微信对同一
 * appid 只认**最新签发**的那一个（新 token 会把旧 token 顶掉），所以「缓存 / 提前过期 / 刷新 /
 * 并发去重」必须只有一份实现：各调各的会互相把对方的 token 提前作废。
 *
 * 安全与失败语义（与 `apps/api/src/modules/auth/wechat-service.ts` 同一原则）：
 * - appid / appSecret 只存在于服务端进程；错误信息**绝不**带 secret，也不带含 secret 的
 *   完整 URL——只报 errcode / errmsg / 错误类型名。
 * - 拿不到 token 一律抛 `WechatAccessTokenError`，调用方 catch 后 fail-closed（不降级、
 *   不无限重试上游）；失败结果不进缓存，下一次调用会重新请求。
 * - 去重在进程内完成，不引入 Redis 等被排除的组件（#294 明确不做）。
 */

/** 微信 `client_credential` 取 token 的端点（凭据走 query，见下方装配）。 */
export const WECHAT_TOKEN_ENDPOINT = 'https://api.weixin.qq.com/cgi-bin/token'

/**
 * 取 token 的超时（毫秒）。
 *
 * 没有超时的 `fetch` 在上游挂死时会一直占着这次调用与一条连接，客户端永远等不到答复；
 * 超时后按「拿不到 token」处理，调用方 fail-closed。
 */
export const WECHAT_TOKEN_TIMEOUT_MS = 5000

/**
 * 提前过期的安全余量（毫秒）。
 *
 * 微信 `expires_in` 是 7200s：如果卡着最后一刻才刷新，「这里刚判定有效、下游拿着它去调上游
 * 时已经过期」的窗口就真实存在。扣掉 5 分钟余量后到期即刷新。
 */
export const WECHAT_TOKEN_SAFETY_MARGIN_MS = 5 * 60 * 1000

/** 失败归类，供调用方区分「网络不可达」「上游拒绝」「响应不可用」并各自决定日志/告警。 */
export type WechatAccessTokenFailure = 'network' | 'upstream' | 'malformed'

/** 拿不到 access_token 的统一信号；调用方 catch 后 fail-closed。 */
export class WechatAccessTokenError extends Error {
  readonly failure: WechatAccessTokenFailure

  constructor(message: string, failure: WechatAccessTokenFailure) {
    super(message)
    this.name = 'WechatAccessTokenError'
    this.failure = failure
  }
}

/**
 * 调用方（#204 / #197）只需依赖这一个方法：拿一个**当前有效**的 token。
 * 缓存、提前过期、并发去重都封在实现里，调用方不需要知道 token 的生命周期。
 */
export interface WechatAccessTokenProvider {
  getAccessToken(): Promise<string>
}

/** 上游响应里我们真正读的字段；全部按 `unknown` 收，避免相信上游类型。 */
type TokenResponse = {
  access_token?: unknown
  expires_in?: unknown
  errcode?: unknown
  errmsg?: unknown
}

export function createWechatAccessTokenProvider(deps: {
  appid: string
  appSecret: string
  /** 时钟注入点（毫秒），单测用来推进过期而不真等 2 小时；默认 `Date.now`。 */
  now?: () => number
  /** 安全余量覆盖，默认 `WECHAT_TOKEN_SAFETY_MARGIN_MS`。 */
  safetyMarginMs?: number
}): WechatAccessTokenProvider {
  const now = deps.now ?? Date.now
  const safetyMarginMs = deps.safetyMarginMs ?? WECHAT_TOKEN_SAFETY_MARGIN_MS

  let cached: { token: string; expiresAt: number } | null = null
  /** 同一时刻共享的上游请求；只在成功/失败收尾时清空（失败因此不会被缓存）。 */
  let inFlight: Promise<string> | null = null

  async function requestToken(): Promise<string> {
    const url = new URL(WECHAT_TOKEN_ENDPOINT)
    url.searchParams.set('grant_type', 'client_credential')
    url.searchParams.set('appid', deps.appid)
    url.searchParams.set('secret', deps.appSecret)

    let res: Response
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(WECHAT_TOKEN_TIMEOUT_MS) })
    } catch (error) {
      // 超时 / DNS / 连接失败：只带错误类型名——异常原文可能含带 secret 的 URL。
      const kind = error instanceof Error ? error.name : 'unknown'
      throw new WechatAccessTokenError(`cgi-bin/token 请求失败（${kind}）`, 'network')
    }
    if (!res.ok) {
      throw new WechatAccessTokenError(`cgi-bin/token HTTP ${res.status}`, 'upstream')
    }

    let body: TokenResponse
    try {
      body = (await res.json()) as TokenResponse
    } catch (error) {
      const kind = error instanceof Error ? error.name : 'unknown'
      throw new WechatAccessTokenError(`cgi-bin/token 响应解析失败（${kind}）`, 'malformed')
    }

    // 40001 invalid credential / 40013 invalid appid / 40164 IP 白名单 / 45009 频率限制……
    const errcode = typeof body.errcode === 'number' ? body.errcode : 0
    if (errcode !== 0) {
      const errmsg = typeof body.errmsg === 'string' ? body.errmsg : ''
      throw new WechatAccessTokenError(
        `cgi-bin/token errcode=${errcode} errmsg=${errmsg}`,
        'upstream',
      )
    }

    const token = typeof body.access_token === 'string' ? body.access_token : ''
    const expiresInSec = typeof body.expires_in === 'number' ? body.expires_in : Number.NaN
    if (token === '' || !Number.isFinite(expiresInSec) || expiresInSec <= 0) {
      throw new WechatAccessTokenError(
        'cgi-bin/token 响应缺少 access_token / expires_in',
        'malformed',
      )
    }

    // 提前过期：`expires_in` 扣掉安全余量。余量比 ttl 还长时（上游给了异常小的 expires_in）
    // 回落为全额 ttl —— 宁可少一次提前刷新，也不返回一个「出生即过期」的 token。
    const rawTtlMs = expiresInSec * 1000
    const ttlMs = rawTtlMs > safetyMarginMs ? rawTtlMs - safetyMarginMs : rawTtlMs
    cached = { token, expiresAt: now() + ttlMs }
    return token
  }

  return {
    async getAccessToken(): Promise<string> {
      // 去重判定放在过期判定之前：in-flight 只会在「缓存已过期 / 还没有缓存」时产生，
      // 先判缓存也能靠后面的 inFlight 兜住，但把去重放在最前面，这个不变量就不依赖
      // 「缓存新鲜 ⟹ 没有 in-flight」这条推理，读者不需要自己论证它。
      if (inFlight) return inFlight

      const hit = cached
      // 只返回**未过期**的缓存：过期的 token 即使还在 cached 里也不外发（刷新失败时同理）。
      if (hit && now() < hit.expiresAt) return hit.token

      const pending = requestToken()
      inFlight = pending
      try {
        return await pending
      } finally {
        // 身份比对后再清：否则「先发起的等待者」收尾时会清掉后来者刚发起的新请求，
        // 让紧随其后的调用重复打上游。
        if (inFlight === pending) inFlight = null
      }
    },
  }
}
