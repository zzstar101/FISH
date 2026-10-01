import {
  isInvalidAccessTokenErrcode,
  WECHAT_PLATFORM_TIMEOUT_MS,
  type WechatAccessTokenService,
} from '../wechat/access-token'

/**
 * 手机号 code 换取（#204）。
 *
 * 与 `wechat-service.ts` 的 `WechatIdentityProvider` 同一拆分原则：**边界协议**在这里
 * （调微信 `phonenumber.getPhoneNumber`），绑定与唯一性语义在 auth service。
 *
 * 与 #197 取码共用同一份 `WechatAccessTokenService`（由 router 装配时注入）：
 * `access_token` 是 appid 级的全局单例资源，两处各建一套缓存会让 `invalidate` 清不掉
 * 对方手里的死凭证。
 *
 * 冻结规则（#204）：端上**只交 code**，不接受明文手机号 / `encryptedData` / `iv` /
 * `cloudID` 作为替代输入——格式正确不是归属证明，只有上游换回来的号码才是可信的。
 */

/**
 * 大陆手机号形状。stub 用它拦「code 不是手机号」，live 用它拦「上游返回了没法入库的值」。
 *
 * 与绑定契约的历史口径一致（`/^1\d{10}$/`）：本平台是校内二手交易，绑定号一律按大陆
 * 11 位手机号处理；live 下不满足的值判上游故障，绝不落库。
 */
export const MAINLAND_PHONE_PATTERN = /^1\d{10}$/

/**
 * 失败分类。**公开契约只映射成两个错误码**（见 `@fish/contracts/auth/phone` 的
 * `PhoneErrorCodeSchema`）：把上游的内部分支逐一暴露没有可执行性。
 *
 * - `code_invalid`：上游明确判定这个 code 不可用（40029 / 40163），或 stub / live
 *   解析出的号码形状不合法。端上重新触发授权拿新 code 才有意义。
 * - `upstream_unavailable`：平台侧故障——凭证失效（本模块已顺手丢弃缓存）、超时、
 *   不可达、响应畸形、其它 `errcode`。重试同一次 code 无意义。
 */
export type PhoneResolveFailure = 'code_invalid' | 'upstream_unavailable'

/**
 * 手机号解析失败的统一信号；router 翻译成 422 `PHONE_CODE_INVALID` / 502
 * `PHONE_UPSTREAM_UNAVAILABLE`。
 *
 * `message` 只用于服务端排查：**不带** code / access_token / 明文号码，也不拼上游
 * `errmsg`（那是上游可控文本，可能回显请求上下文）。
 */
export class PhoneResolveError extends Error {
  constructor(
    message: string,
    readonly failure: PhoneResolveFailure,
  ) {
    super(message)
    this.name = 'PhoneResolveError'
  }
}

export type PhoneResolver = {
  /** code → 明文手机号。失败抛 `PhoneResolveError`。明文只在服务端流转，不进响应。 */
  resolve(code: string): Promise<string>
}

/**
 * stub resolver：`code` 即明文手机号（`WECHAT_TRANSPORT=stub` 的演示语义，与
 * `createStubWechatIdentityProvider` 同一档：不验证微信签发的凭证，只允许非生产显式开启）。
 *
 * 形状校验放在 resolver 内而不是 router 里：这样「非法输入 → code_invalid」这条
 * 分类对 stub / live 是同一处出口，router 不再需要自己判断。
 */
export function createStubPhoneResolver(): PhoneResolver {
  return {
    async resolve(code) {
      const phone = code.trim()
      if (!MAINLAND_PHONE_PATTERN.test(phone)) {
        throw new PhoneResolveError('stub：code 不是 11 位手机号', 'code_invalid')
      }
      return phone
    },
  }
}

/**
 * live resolver：真实 `POST wxa/business/getuserphonenumber`。
 *
 * 成功响应形如 `{ errcode: 0, phone_info: { purePhoneNumber, phoneNumber, countryCode } }`；
 * 取 `purePhoneNumber`（官方定义：不带区号的号码），本平台不存区号。
 *
 * AppSecret 只经由 `tokens` 存在于服务端进程，绝不进日志；本模块的错误信息一律不带
 * 请求 URL（URL 上挂着 access_token）。
 */
export function createLivePhoneResolver(deps: {
  tokens: WechatAccessTokenService
  /** 注入点：单测替换上游，生产用全局 fetch。 */
  fetchImpl?: typeof fetch
  /** 注入点：单测把超时压到毫秒级，不必真的等 5s。 */
  timeoutMs?: number
}): PhoneResolver {
  const doFetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    (deps.fetchImpl ?? fetch)(input, init)
  const timeoutMs = deps.timeoutMs ?? WECHAT_PLATFORM_TIMEOUT_MS

  return {
    async resolve(code) {
      let token: string
      try {
        token = await deps.tokens.get()
      } catch (error) {
        // 取凭证失败（含退避窗口内的快速失败）。这是平台侧问题，与用户的 code 无关。
        const kind = error instanceof Error ? error.name : 'unknown'
        throw new PhoneResolveError(
          `getuserphonenumber 取凭证失败（${kind}）`,
          'upstream_unavailable',
        )
      }

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
        // 超时 / DNS / 连接失败。只带错误类型名——异常原文可能带出含 access_token 的 URL。
        const kind = error instanceof Error ? error.name : 'unknown'
        throw new PhoneResolveError(
          `getuserphonenumber 请求失败（${kind}）`,
          'upstream_unavailable',
        )
      }

      const body = (await res.json().catch(() => null)) as {
        errcode?: unknown
        phone_info?: { purePhoneNumber?: unknown } | null
      } | null
      if (body === null) {
        // 网关错误页 / 空体。不拼响应原文与 content-type：同样是上游可控文本。
        throw new PhoneResolveError(
          `getuserphonenumber 响应不是 JSON（HTTP ${res.status}）`,
          'upstream_unavailable',
        )
      }

      // `errcode` 的三种形态分开处理（原则与 `wechat-platform.ts` 一致——只信任整数 `errcode`；
      // 那边只在失败路径读它，所以没有「缺失」这一支，不能照搬）：
      // - **缺失**：按成功形状继续，交给下面的 phone_info 校验兜底；
      // - **存在但非整数**（`"0"` / `1.5` / `null`）：畸形响应，fail closed —— 既不当成功去读
      //   phone_info，也不把可控文本拼进会进日志的 message；
      // - **存在且为整数**：非 0 即失败（上游从不发 `errcode: 0` 以外表示成功的值）。
      const rawErrcode = body.errcode
      if (rawErrcode !== undefined) {
        if (typeof rawErrcode !== 'number' || !Number.isInteger(rawErrcode)) {
          throw new PhoneResolveError(
            'getuserphonenumber 响应的 errcode 格式非法',
            'upstream_unavailable',
          )
        }
        if (rawErrcode !== 0) {
          // 凭证失效（40001 / 40014 / 42001）先丢掉**这一个** token，否则会拿着死凭证
          // 一直重试到本地 expiresAt。传 token 而不是无条件清：并发下另一个请求可能
          // 已经刷出了新凭证（见 access-token 的 invalidate 语义）。
          if (isInvalidAccessTokenErrcode(rawErrcode)) deps.tokens.invalidate(token)
          // 40029 code 无效 / 40163 code 已被使用——**唯一**判给用户的分支。
          if (rawErrcode === 40029 || rawErrcode === 40163) {
            throw new PhoneResolveError(`getuserphonenumber errcode=${rawErrcode}`, 'code_invalid')
          }
          // 其余（45011 频控、-1 系统繁忙、48001 接口未授权……）都是平台侧，不是用户输入的问题。
          throw new PhoneResolveError(
            `getuserphonenumber errcode=${rawErrcode}`,
            'upstream_unavailable',
          )
        }
      }
      if (!res.ok) {
        throw new PhoneResolveError(`getuserphonenumber HTTP ${res.status}`, 'upstream_unavailable')
      }

      const phone =
        typeof body.phone_info?.purePhoneNumber === 'string'
          ? body.phone_info.purePhoneNumber.trim()
          : ''
      if (!MAINLAND_PHONE_PATTERN.test(phone)) {
        // 缺字段 / 返回了没法入库的值。不把上游返回的原文带进 message。
        throw new PhoneResolveError('getuserphonenumber 未返回可用的手机号', 'upstream_unavailable')
      }
      return phone
    },
  }
}
