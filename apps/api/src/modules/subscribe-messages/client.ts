import type { WechatQrEnvVersion } from '@fish/shared/env'
import {
  isInvalidAccessTokenErrcode,
  WECHAT_PLATFORM_TIMEOUT_MS,
  type WechatAccessTokenService,
} from '../wechat/access-token'

/**
 * 微信一次性订阅消息的发送客户端（#462）。
 *
 * 与 `modules/auth/wechat-platform.ts` 的分工一致：**凭证只从共用的
 * `WechatAccessTokenService`（#294）取**，本文件不建第二个缓存、不建刷新循环，只负责
 * 调 `subscribe/send` 并把响应归成三类可决策的结果。
 *
 * 为什么把「分类」放在客户端而不是调度器里：errcode 的语义是上游协议的一部分，
 * 只有这里同时看得到请求与响应。调度器只消费 `retryable / permanent / no-quota`，
 * 「哪个码属于哪类」写在一处才不会被两处改歪。
 */

export const SUBSCRIBE_SEND_URL = 'https://api.weixin.qq.com/cgi-bin/message/subscribe/send'

/**
 * 微信「用户拒绝 / 没有可用的订阅次数」：`43101`。
 *
 * 这不是故障，而是**额度的事实**——Owner 冻结口径要求把它当成「用户拒绝」：
 * 该 kind 的本地计数直接置 0（我们与微信的账已经对不上了，继续扣没有意义）。
 */
export const SUBSCRIBE_ERRCODE_NO_QUOTA = 43101

/**
 * 参数类错误码：**重试没有意义**（重试拿到的是同一个 47003）。
 *
 * - `40003` touser（openid）无效或不属于该小程序；
 * - `40037` template_id 无效（模板被删 / env 配错）；
 * - `41030` page 路径不存在（端上路由改了）；
 * - `47003` 参数不合法（字段超长 / 字段名对不上模板）。
 *
 * 其余 4xx 类（如 `45009` 接口调用超过限额、`45011` 频率限制）都是**可重试**的：
 * 它们由时间或上游负载决定，指数退避之后大概率能过。
 */
const PERMANENT_ERRCODES = new Set([40003, 40037, 41030, 47003])

/**
 * 模板字段 → 微信要求的 `{ value }` 信封。
 *
 * `subscribe/send` 的 `data` 是 `{ "thing4": { "value": "林一" } }`，**不是**扁平字符串：
 * 直接发 `{ "thing4": "林一" }` 会被上游判 47003（参数不合法），而 47003 在我们这边属于
 * 「参数类错误、不重试」，表现就是每一条都静默失败。
 *
 * 库里（`subscribe_message_deliveries.data`）与模板层（`templates.ts`）一律只存扁平
 * `Record<string, string>`——转换只在这一个**出站边界**发生，别处不许再包一层。
 */
export function toWechatTemplateData(
  data: Record<string, string>,
): Record<string, { value: string }> {
  return Object.fromEntries(Object.entries(data).map(([field, value]) => [field, { value }]))
}

/** 小程序版本 → `miniprogram_state`。Owner 冻结：由 `WECHAT_QR_ENV_VERSION` 映射。 */
export type MiniprogramState = 'developer' | 'trial' | 'formal'

export function miniprogramStateOf(envVersion: WechatQrEnvVersion): MiniprogramState {
  if (envVersion === 'develop') return 'developer'
  if (envVersion === 'trial') return 'trial'
  return 'formal'
}

/** 发送结果。`detail` 是**脱敏**短串（`errcode=47003` / `http-502` / `timeout`），可落库与打日志。 */
export type SubscribeSendOutcome =
  | { ok: true }
  | { ok: false; reason: 'no-quota'; errcode: number; detail: string }
  | { ok: false; reason: 'permanent'; errcode: number; detail: string }
  | { ok: false; reason: 'retryable'; errcode?: number; detail: string }

export type SubscribeMessageClient = {
  /**
   * 发一条订阅消息。**不抛异常**：所有失败都归成 `ok: false`，让调用方的状态机只有一条路径。
   * `data` 的键是模板字段名（`thing4` / `phrase3` …）。
   */
  send(input: {
    openid: string
    templateId: string
    /** 点击通知打开的小程序页面，不带前导 `/`，可带参数。 */
    page: string
    data: Record<string, string>
  }): Promise<SubscribeSendOutcome>
}

type RawOutcome =
  | { kind: 'ok' }
  | { kind: 'errcode'; errcode: number }
  | { kind: 'transport'; detail: string }

export function createSubscribeMessageClient(deps: {
  tokens: WechatAccessTokenService
  miniprogramState: MiniprogramState
  /** 注入点：单测替换上游，生产用全局 fetch（在调用时解析，与 #294 同一取舍）。 */
  fetchImpl?: typeof fetch
  /** 注入点：单测把超时压到毫秒级。 */
  timeoutMs?: number
}): SubscribeMessageClient {
  const doFetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    (deps.fetchImpl ?? fetch)(input, init)
  const timeoutMs = deps.timeoutMs ?? WECHAT_PLATFORM_TIMEOUT_MS

  async function post(
    token: string,
    input: Parameters<SubscribeMessageClient['send']>[0],
  ): Promise<RawOutcome> {
    const url = new URL(SUBSCRIBE_SEND_URL)
    url.searchParams.set('access_token', token)

    let res: Response
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          touser: input.openid,
          template_id: input.templateId,
          page: input.page,
          // 微信要 `{ field: { value } }`，见 `toWechatTemplateData` 的注释。
          data: toWechatTemplateData(input.data),
          miniprogram_state: deps.miniprogramState,
          lang: 'zh_CN',
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      // 超时 / DNS / 连接中断。只带错误类型名：异常原文可能带出含 access_token 的请求 URL。
      const kind = error instanceof Error ? error.name : 'unknown'
      return { kind: 'transport', detail: `fetch-${kind}` }
    }
    if (!res.ok) return { kind: 'transport', detail: `http-${res.status}` }

    const body = (await res.json().catch(() => null)) as { errcode?: unknown } | null
    if (body === null) return { kind: 'transport', detail: 'bad-json' }
    // `errcode` 必须是非负整数（`-1` 是微信的「系统繁忙」，它是**合法值**，不能当脏数据丢）。
    if (typeof body.errcode !== 'number' || !Number.isInteger(body.errcode)) {
      return { kind: 'transport', detail: 'bad-errcode' }
    }
    if (body.errcode === 0) return { kind: 'ok' }
    return { kind: 'errcode', errcode: body.errcode }
  }

  return {
    async send(input) {
      let token: string
      try {
        token = await deps.tokens.get()
      } catch {
        // 取凭证失败（上游故障 / 退避窗口内）：这是可重试的，不是这条消息的错。
        return { ok: false, reason: 'retryable', detail: 'token-unavailable' }
      }

      // 最多两次：命中「凭证失效」时丢弃缓存重取一次（Owner 冻结口径），其它失败不再重试。
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await post(token, input)
        if (result.kind === 'ok') return { ok: true }
        if (result.kind === 'transport') {
          return { ok: false, reason: 'retryable', detail: result.detail }
        }
        if (isInvalidAccessTokenErrcode(result.errcode)) {
          // 只清**这一个** token（传 expectedToken）：并发下别的请求可能已经换好了新的。
          deps.tokens.invalidate(token)
          if (attempt === 0) {
            try {
              token = await deps.tokens.get()
            } catch {
              return { ok: false, reason: 'retryable', detail: 'token-unavailable' }
            }
            continue
          }
          // 换过凭证还是失效：上游状态异常，按可重试处理（退避后再来）。
          return {
            ok: false,
            reason: 'retryable',
            errcode: result.errcode,
            detail: `errcode=${result.errcode}`,
          }
        }
        if (result.errcode === SUBSCRIBE_ERRCODE_NO_QUOTA) {
          return {
            ok: false,
            reason: 'no-quota',
            errcode: result.errcode,
            detail: `errcode=${result.errcode}`,
          }
        }
        if (PERMANENT_ERRCODES.has(result.errcode)) {
          return {
            ok: false,
            reason: 'permanent',
            errcode: result.errcode,
            detail: `errcode=${result.errcode}`,
          }
        }
        return {
          ok: false,
          reason: 'retryable',
          errcode: result.errcode,
          detail: `errcode=${result.errcode}`,
        }
      }
      // 到不了这里（循环里每条分支都 return 了）；留着让类型收敛。
      return { ok: false, reason: 'retryable', detail: 'unreachable' }
    },
  }
}
