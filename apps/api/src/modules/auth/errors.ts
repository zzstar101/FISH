import type { AuthErrorCodeAll } from '@fish/contracts/auth/verification'

/**
 * 认证域的失败信号：service 只负责抛它，HTTP 状态码与响应体由 router 统一翻译。
 * 这样「错误码 ↔ 状态码」的映射只有一处，不会散落在各个 handler 里。
 *
 * `AuthErrorCodeAll` = 会话子域（`session.ts`）+ 校园认证子域（`verification.ts`）。
 */
export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCodeAll,
    readonly status: 401 | 409 | 429,
    message: string,
  ) {
    super(message)
    this.name = 'AuthError'
  }
}
