/**
 * 校园认证页的行内文案：后端错误码 → 可执行文案（#380）。
 *
 * 单独成模块而不是写进页面：这是本域唯一可纯函数验证的部分，用例见 `./messages.test.ts`。
 * 码的取值见 `@fish/contracts/auth/verification` 的 `VerificationErrorCodeSchema`，
 * 服务端出处见 `apps/api/src/modules/auth/verification-service.ts` /
 * `verification-store.ts`。
 */

/**
 * 发码失败文案。
 *
 * `RATE_LIMITED` 刻意不在表里：服务端把「还有几秒 / 今日已用完」写进了 message
 * （`verification-store.ts`），照抄它比一句笼统的「太频繁」有用。
 */
const SEND_MESSAGES: Record<string, string> = {
  EMAIL_ALREADY_BOUND: '该校园邮箱已绑定其他账号',
  ALREADY_VERIFIED: '已完成校园认证，无需重复获取验证码',
  VALIDATION_FAILED: '请使用校园教育邮箱',
}

/** 校验失败文案（`RATE_LIMITED` 同上，走服务端 message）。 */
const VERIFY_MESSAGES: Record<string, string> = {
  CODE_INVALID: '验证码不正确，请核对后重新输入',
  CODE_EXPIRED: '验证码已过期，请重新获取',
  CODE_CONSUMED: '验证码已被使用，请重新获取',
  TOO_MANY_ATTEMPTS: '尝试次数过多，请重新获取验证码',
  EMAIL_ALREADY_BOUND: '该校园邮箱已绑定其他账号',
  ALREADY_VERIFIED: '已完成校园认证，无需重复验证',
  VALIDATION_FAILED: '请检查邮箱与验证码后重试',
}

/**
 * 这几类失败意味着手上这枚码已不可用（或本次输入已无重试价值），
 * 页面必须解锁「重新发送」，否则用户被自己的 60 秒倒计时锁住，只能干等。
 */
const NEEDS_RESEND = new Set(['CODE_EXPIRED', 'CODE_CONSUMED', 'TOO_MANY_ATTEMPTS'])

/**
 * 发码失败的行内文案。
 *
 * 未知码与 `RATE_LIMITED` 一律透传服务端 message —— 错误信封里的 message 本来就是
 * 面向用户的，编一句更笼统的反而丢掉「还有几秒」这类可操作信息。
 */
export function sendErrorMessage(code: string, backendMessage: string): string {
  if (code === 'RATE_LIMITED') return backendMessage
  return SEND_MESSAGES[code] ?? backendMessage
}

/** 校验失败的行内文案（口径同 `sendErrorMessage`）。 */
export function verifyErrorMessage(code: string, backendMessage: string): string {
  if (code === 'RATE_LIMITED') return backendMessage
  return VERIFY_MESSAGES[code] ?? backendMessage
}

/** 该失败码是否要解锁重发。 */
export function verifyNeedsResend(code: string): boolean {
  return NEEDS_RESEND.has(code)
}
