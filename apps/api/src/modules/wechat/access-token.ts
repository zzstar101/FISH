/**
 * 共用微信 `access_token` 服务（#294）。
 *
 * 为什么单独立一个模块：`access_token` 是**全局单例资源**——一个 appid 在微信侧只有一份
 * 有效凭证，`force_refresh` 之类还会让旧值立刻失效。扫码登录（#197）与手机号换取（#204）
 * 都要用它，所以缓存与刷新必须**只有一份**，绝不允许各自实现一套循环。
 *
 * 选 `POST /cgi-bin/stable_token` 而不是 `GET /cgi-bin/token`，依据是官方原文：
 * - 普通模式（不传 `force_refresh`）下「access_token 有效期内重复调用该接口不会更新」；
 * - 「普通模式下平台会提前 5 分钟更新 access_token」；
 * - 「与 getAccessToken 获取的调用凭证完全隔离，互不影响」；
 * - 而 `force_refresh=true`「会导致上次获取的 access_token 失效」，且**每天限用 20 次**——
 *   生产上用它等于自毁，代码里刻意不提供这个开关。
 *
 * 因此本地只需要：缓存到「过期时间 - 5 分钟」+ 单飞去重 + 超时。刷新去重不是我们自己发明的
 * 协议，而是上面两条官方语义的直接推论。
 */

/**
 * 上游超时（毫秒）。与 `wechat-service.ts` 的 `WECHAT_EXCHANGE_TIMEOUT_MS` 同一取舍：
 * 没有超时的 `fetch` 在上游挂死时会一直占着这次请求与一条 Bun.serve 连接。
 */
export const WECHAT_PLATFORM_TIMEOUT_MS = 5000

/** 官方：stable_token 普通模式下平台提前 5 分钟换发；本地按同一时长提前作废缓存。 */
export const ACCESS_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000

/**
 * `expires_in` 的本地上界（毫秒）。官方口径是「目前是 7200 秒之内的值」，这里给足余量到
 * 24 小时。没有上界时，一个有限但荒谬的 `expires_in`（如 1e10）会算出「永不自然过期」的
 * 凭证——之后只能靠取码 40001 自愈。
 */
export const MAX_ACCESS_TOKEN_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 失败退避阶梯（毫秒）：连续失败按 1s → 2s → 4s → 8s 递增，8s 封顶。
 *
 * 为什么必须有：并发单飞只能合并**同一时刻**的请求，挡不住上游故障期间每个业务请求都立刻
 * 再打一次微信——那是把一次抖动放大成重试风暴。退避窗口内直接快速失败，窗口过后才允许再试；
 * 成功一次即清零。窗口只挡「重新取凭证」，不影响仍在有效期内的缓存命中。
 */
export const ACCESS_TOKEN_FAILURE_BACKOFF_MS = [1000, 2000, 4000, 8000] as const

/** 退避阶梯取完后的兜底值（与最后一档相同）。 */
const ACCESS_TOKEN_BACKOFF_CAP_MS = 8000

/**
 * 微信「凭证不可用」类错误码，命中就丢掉本地缓存：
 * `40001` invalid credential / `40014` invalid access_token / `42001` token 过期。
 * 少收一个的代价是拿着死 token 一直重试到本地 `expiresAt`。
 */
/** `errcode` 是否属于「凭证不可用」类（调用方应丢弃缓存的那一类）。 */
export function isInvalidAccessTokenErrcode(errcode: number): boolean {
  return INVALID_ACCESS_TOKEN_ERRCODES.has(errcode)
}

const INVALID_ACCESS_TOKEN_ERRCODES = new Set([40001, 40014, 42001])

/** 平台侧失败信号。`errcode` 原样保留，供路由层区分「凭证失效」与「参数/权限问题」。 */
export class WechatPlatformError extends Error {
  constructor(
    message: string,
    readonly errcode?: number,
  ) {
    super(message)
    this.name = 'WechatPlatformError'
  }
}

export type WechatAccessTokenService = {
  /** 取有效凭证；缓存命中不发请求，并发调用共用同一次上游请求。 */
  get(): Promise<string>
  /**
   * 丢弃缓存。上游回「凭证无效」时调用它——否则我们会拿着一个已被平台判死的 token
   * 一直重试到 `expiresAt`。
   *
   * 传 `expectedToken` 时**只清就是它**的那份缓存：并发下两个取码请求都用了旧 token T1，
   * A 的 40001 已经刷新出 T2，B 迟到的 40001 不该把 T2 也清掉。不传则无条件清。
   */
  invalidate(expectedToken?: string): void
}

type TokenFetchDeps = {
  appid: string
  appSecret: string
  /** 注入点：单测替换上游，生产用全局 fetch。 */
  fetchImpl?: typeof fetch
  /** 注入点：单测控制时间推进，不真的 sleep。 */
  now?: () => number
  /** 注入点：单测把超时压到毫秒级，不必真的等 5s。 */
  timeoutMs?: number
}

export function createWechatAccessTokenService(deps: TokenFetchDeps): WechatAccessTokenService {
  // 默认 fetch **在调用时**解析，而不是构造时捕获：进程是长驻的，且测试会替换全局 fetch
  // （app 级用例没法往 createApp 内部注入 fetchImpl）。
  const doFetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    (deps.fetchImpl ?? fetch)(input, init)
  const now = deps.now ?? (() => Date.now())
  const timeoutMs = deps.timeoutMs ?? WECHAT_PLATFORM_TIMEOUT_MS

  let cached: { token: string; expiresAt: number } | null = null
  let inFlight: Promise<{ token: string; expiresAt: number }> | null = null
  let consecutiveFailures = 0
  let blockedUntil = 0
  let lastFailure: WechatPlatformError | null = null

  async function requestToken(): Promise<{ token: string; expiresAt: number }> {
    let res: Response
    try {
      res = await doFetch('https://api.weixin.qq.com/cgi-bin/stable_token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // 刻意不传 force_refresh：默认 false 即「有效期内不更新」，正是我们要的幂等语义。
        body: JSON.stringify({
          grant_type: 'client_credential',
          appid: deps.appid,
          secret: deps.appSecret,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      // 超时 / DNS / 连接失败。只带错误类型名——异常原文可能带出请求上下文。
      const kind = error instanceof Error ? error.name : 'unknown'
      throw new WechatPlatformError(`stable_token 请求失败（${kind}）`)
    }
    if (!res.ok) throw new WechatPlatformError(`stable_token HTTP ${res.status}`)

    const body = (await res.json().catch(() => null)) as {
      access_token?: string
      expires_in?: number
      errcode?: number
    } | null
    if (body === null) throw new WechatPlatformError('stable_token 响应不是 JSON')
    // `errcode` 来自上游：非整数一律按**失败**处理（fail closed），既不把它当成功凭证，
    // 也不把可控文本拼进会进日志的 message。
    if (body.errcode !== undefined) {
      if (typeof body.errcode !== 'number' || !Number.isInteger(body.errcode)) {
        throw new WechatPlatformError('stable_token 响应的 errcode 格式非法')
      }
      if (body.errcode !== 0) {
        // 刻意不拼 `errmsg`：上游原文可能回显请求上下文（含 scene/凭证）。
        throw new WechatPlatformError(`stable_token errcode=${body.errcode}`, body.errcode)
      }
    }
    // 严格校验：`access_token: 123` 这种 truthy 非字符串、以及 `1e400` 这类溢出成
    // Infinity 的 expires_in，都会让「畸形响应」被当成有效凭证缓存（后者甚至永不过期）。
    // trim 后再判空：带空白的凭证拼进 URL 会直接失效。
    const accessToken = typeof body.access_token === 'string' ? body.access_token.trim() : ''
    if (accessToken.length === 0) {
      throw new WechatPlatformError('stable_token 响应缺少 access_token')
    }
    const ttlMs = typeof body.expires_in === 'number' ? body.expires_in * 1000 : Number.NaN
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_ACCESS_TOKEN_TTL_MS) {
      throw new WechatPlatformError('stable_token 响应的 expires_in 不在预期范围内')
    }
    // 官方口径里 expires_in「目前是 7200 秒之内的值」；取余量后若已不足 5 分钟，
    // 自然退化成「每次调用都重新取」，不会把过期凭证当成有效凭证用。
    const ttl = Math.max(0, ttlMs - ACCESS_TOKEN_REFRESH_MARGIN_MS)
    return { token: accessToken, expiresAt: now() + ttl }
  }

  return {
    async get() {
      const nowMs = now()
      // 缓存优先：退避窗口只挡「重新取凭证」，不该把手上还有效的凭证一起挡掉。
      if (cached !== null && cached.expiresAt > nowMs) return cached.token
      // 窗口内快速失败：上游故障期间不能让每个业务请求都再去打一次微信。
      if (blockedUntil > nowMs && lastFailure !== null) throw lastFailure

      if (inFlight === null) {
        inFlight = requestToken()
          .then((next) => {
            cached = next
            consecutiveFailures = 0
            blockedUntil = 0
            lastFailure = null
            return next
          })
          .catch((error: unknown) => {
            const failure =
              error instanceof WechatPlatformError
                ? error
                : new WechatPlatformError('stable_token 取凭证失败')
            consecutiveFailures += 1
            const step = Math.min(consecutiveFailures, ACCESS_TOKEN_FAILURE_BACKOFF_MS.length)
            blockedUntil =
              now() + (ACCESS_TOKEN_FAILURE_BACKOFF_MS[step - 1] ?? ACCESS_TOKEN_BACKOFF_CAP_MS)
            lastFailure = failure
            throw failure
          })
          // 无论成功失败都清掉在途标记：失败不能被缓存，否则一次网络抖动会毒到进程重启。
          .finally(() => {
            inFlight = null
          })
      }
      return (await inFlight).token
    },

    invalidate(expectedToken?: string) {
      if (expectedToken === undefined || cached?.token === expectedToken) cached = null
    },
  }
}
