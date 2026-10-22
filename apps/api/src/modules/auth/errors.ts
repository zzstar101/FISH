import type { AuthErrorCodeAll } from '@fish/contracts/auth/verification'

/**
 * 认证域的失败信号：service 只负责抛它，HTTP 状态码与响应体由 router 统一翻译。
 * 这样「错误码 ↔ 状态码」的映射只有一处，不会散落在各个 handler 里。
 *
 * `AuthErrorCodeAll` = 会话子域（`session.ts`）+ 校园认证子域（`verification.ts`）
 * + 扫码登录子域（`scan.ts`）。
 *
 * 状态码取值里**当前真实被用到**的是 401 / 404（#197 票据无效，四种原因刻意合并）/ 409；
 * 429 与 502 目前没有 `new AuthError(...)` 调用方——429 由限流中间件 inline 返回，两处 502
 * （#197 平台取码失败、#204 `PHONE_UPSTREAM_FAILED`）在 router 里 inline 返回，文案要按具体
 * 失败面区分。两者仍留在联合类型里，是为了「映射只有一处」：将来 service 要表达限流或上游
 * 故障时不必再改这个类型。
 *
 * 同样由 router 直接返回、不经 AuthError 的还有：`VALIDATION_FAILED`(422)、
 * `WECHAT_DISABLED`(503)、`PHONE_CODE_INVALID`(422)、`PHONE_NUMBER_UNSUPPORTED`(422)、
 * `PHONE_UPSTREAM_FAILED`(502)——#204 的三种手机号失败面由 `toPhoneBindErrorResponse` 统一
 * 翻译，理由是必须把「上游故障」与「用户 code 错误」区分开（否则用户会对着正确授权反复重试）。
 */
export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCodeAll,
    readonly status: 401 | 404 | 409 | 429 | 502,
    message: string,
  ) {
    super(message)
    this.name = 'AuthError'
  }
}
