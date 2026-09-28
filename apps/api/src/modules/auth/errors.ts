import type { AuthErrorCodeAll } from '@fish/contracts/auth/verification'

/**
 * 认证域的失败信号：service 只负责抛它，HTTP 状态码与响应体由 router 统一翻译。
 * 这样「错误码 ↔ 状态码」的映射只有一处，不会散落在各个 handler 里。
 *
 * `AuthErrorCodeAll` = 会话子域（`session.ts`）+ 校园认证子域（`verification.ts`）
 * + 扫码登录子域（`scan.ts`）。
 *
 * 状态码取值覆盖三个子域中**经 AuthError 抛出**的那些：#197 的扫码登录需要 404
 * （票据无效，四种原因刻意合并）与 502（平台取码失败），它们必须能走同一条通道，
 * 否则「映射只有一处」的约束会被绕过。仍由 router 直接返回、不经 AuthError 的有
 * `VALIDATION_FAILED`(422)、`WECHAT_DISABLED`(503)、`PHONE_CODE_INVALID`(422)。
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
