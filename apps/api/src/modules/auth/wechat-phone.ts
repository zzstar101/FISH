import {
  isInvalidAccessTokenErrcode,
  WECHAT_PLATFORM_TIMEOUT_MS,
  type WechatAccessTokenService,
  WechatPlatformError,
} from '../wechat/access-token'

/**
 * 手机号快速验证组件（#204）：`phonenumber.getUserPhoneNumber` 的服务端换取。
 *
 * 链路（契约见 `@fish/contracts/auth/phone`）：端上 `<button open-type="getPhoneNumber">`
 * 拿一次性动态 `code` → `POST /auth/phone/bind` → 本模块消费 code 换明文号码 → 写 `users.phone`。
 * 端上只交 code：格式正确不是归属证明，只有上游核验过的号码才算数。
 *
 * 三条边界：
 * - `code` 的问题（无效 / 已用）**不是**上游故障，重试多少次都一样 → `PhoneCodeInvalidError`；
 * - 换取成功但号码不是 11 位大陆手机号（本产品只服务大陆手机号）→ `PhoneNumberUnsupportedError`；
 * - 凭证失效（40001/40014/42001）值得换一张 token 重试一次，其余上游故障一律 `WechatPlatformError`。
 *
 * `access_token` 与扫码登录出码共用 `createWechatAccessTokenService` 的**同一份**缓存与刷新循环
 * （#294 / #204：绝不允许两套缓存或两个刷新循环）。本模块不自建 token、不做退避——那是 token 服务的职责。
 *
 * 日志安全：请求 URL 上带 `access_token`，所以错误信息只留错误类型名 / HTTP 状态 / `errcode`，
 * 绝不把异常原文或 URL 拼进 message。
 */

/**
 * 官方 `phone_info` 里我们能用的两个字段：`purePhoneNumber` 是不带国家码的号码，
 * `phoneNumber` 可能带 `+86`。两个字段都参与判定，命中其一即采用。
 */
const CN_MOBILE_PATTERN = /^1\d{10}$/

/**
 * 把上游给的号码收敛成 11 位大陆号；不是大陆号返回 null。
 *
 * 带 `+86` 的情况必须剥掉再判——`phoneNumber` 官方就可能带国家码，不剥等于把「大陆号」
 * 误判成「不支持的号码」，而这两者的用户引导完全不同（见 router 的错误映射）。
 */
function toCnMobile(raw: string): string | null {
  const trimmed = raw.trim()
  const withoutCountryCode = trimmed.startsWith('+86') ? trimmed.slice(3) : trimmed
  return CN_MOBILE_PATTERN.test(withoutCountryCode) ? withoutCountryCode : null
}

/**
 * 「这个 code 不能用」的官方错误码：
 * - `40029` invalid code（无效 / 过期 / 不是本小程序的 code）；
 * - `40163` code been used（已被消费过——每个 code 只能换一次）。
 */
const INVALID_CODE_ERRCODES = new Set([40029, 40163])

/** `code` 无效 / 过期 / 已用：用户侧可纠正（重新点一次授权按钮），不是服务故障。 */
export class PhoneCodeInvalidError extends Error {
  constructor() {
    super('phone code invalid')
    this.name = 'PhoneCodeInvalidError'
  }
}

/** 换取成功但号码不可用于本产品（非 11 位大陆手机号）。同样属于用户侧可纠正。 */
export class PhoneNumberUnsupportedError extends Error {
  constructor() {
    super('phone number unsupported')
    this.name = 'PhoneNumberUnsupportedError'
  }
}

export type WechatPhoneClient = {
  /** 消费一次性 `code`，返回**已由平台核验**的明文手机号。失败抛上面三种错误之一。 */
  resolve(code: string): Promise<string>
}

export function createWechatPhoneClient(deps: {
  tokens: WechatAccessTokenService
  /** 注入点：单测替换上游，生产用全局 fetch。 */
  fetchImpl?: typeof fetch
  /** 注入点：单测把超时压到毫秒级。 */
  timeoutMs?: number
}): WechatPhoneClient {
  const doFetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    (deps.fetchImpl ?? fetch)(input, init)
  const timeoutMs = deps.timeoutMs ?? WECHAT_PLATFORM_TIMEOUT_MS

  async function request(token: string, code: string): Promise<string> {
    const url = new URL('https://api.weixin.qq.com/wxa/business/getuserphonenumber')
    url.searchParams.set('access_token', token)
    let res: Response
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      // 超时 / DNS / 连接失败。只带错误类型名——异常原文可能带着含 token 的 URL。
      const kind = error instanceof Error ? error.name : 'unknown'
      throw new WechatPlatformError(`getuserphonenumber 请求失败（${kind}）`)
    }
    // 微信业务错误一律是 `200 + errcode`；非 2xx 只可能是网关 / 代理 / 网络层故障，
    // 因此这里先判状态码、不解析 body：把网关 5xx 里的 errcode 当业务错误解读反而会误判。
    if (!res.ok) throw new WechatPlatformError(`getuserphonenumber HTTP ${res.status}`)

    const body = (await res.json().catch(() => null)) as {
      errcode?: number
      errmsg?: string
      phone_info?: { phoneNumber?: string; purePhoneNumber?: string; countryCode?: string }
    } | null
    if (body === null) throw new WechatPlatformError('getuserphonenumber 响应不是 JSON')

    // `errcode` 来自上游：非整数一律按失败处理（fail closed），也不把它拼进会进日志的文本。
    if (body.errcode !== undefined && body.errcode !== 0) {
      if (typeof body.errcode !== 'number' || !Number.isInteger(body.errcode)) {
        throw new WechatPlatformError('getuserphonenumber 响应的 errcode 格式非法')
      }
      if (INVALID_CODE_ERRCODES.has(body.errcode)) throw new PhoneCodeInvalidError()
      // 第二个参数必须带上：调用方靠 `errcode` 判断「凭证失效、值得换 token 重试一次」。
      throw new WechatPlatformError(`getuserphonenumber errcode=${body.errcode}`, body.errcode)
    }

    const info = body.phone_info
    // 没有 phone_info 是上游契约被破坏（不是号码问题），不能当成「用户号码不支持」。
    if (info === undefined || info === null) {
      throw new WechatPlatformError('getuserphonenumber 响应缺少 phone_info')
    }
    // 国家码比号码形态更硬：`+1` 之类的 11 位号码也长得像大陆号，只靠正则会把境外号落库。
    // 上游没给 countryCode 时退回形态判断（不因此拒绝，否则一次字段缺失就废掉整个绑定）。
    const countryCode = typeof info.countryCode === 'string' ? info.countryCode.trim() : ''
    if (countryCode !== '' && countryCode !== '86') throw new PhoneNumberUnsupportedError()
    // 只有**拿到了字符串**却不像大陆号码，才算「号码不支持」（用户侧可纠正）；
    // 两个字段都缺失 / 不是字符串，说明上游契约被破坏，必须报上游故障——
    // 否则用户会照着「请使用中国大陆手机号」去换号，而问题根本不在他那一边。
    const raw = [info.purePhoneNumber, info.phoneNumber].filter(
      (value): value is string => typeof value === 'string' && value.trim() !== '',
    )
    if (raw.length === 0) {
      throw new WechatPlatformError('getuserphonenumber 响应的号码字段缺失或类型非法')
    }
    for (const candidate of raw) {
      const mobile = toCnMobile(candidate)
      if (mobile !== null) return mobile
    }
    throw new PhoneNumberUnsupportedError()
  }

  return {
    async resolve(code) {
      let token = await deps.tokens.get()
      try {
        return await request(token, code)
      } catch (error) {
        const invalidToken =
          error instanceof WechatPlatformError &&
          error.errcode !== undefined &&
          isInvalidAccessTokenErrcode(error.errcode)
        // 只对「凭证失效」换一张重试一次：其余失败重试只会多烧一次计费调用。
        // 递 `expectedToken` 是为了并发下不误清别人刚刷出来的新 token。
        if (!invalidToken) throw error
        deps.tokens.invalidate(token)
        token = await deps.tokens.get()
        return await request(token, code)
      }
    },
  }
}
