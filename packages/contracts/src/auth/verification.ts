import { z } from 'zod'
import { AuthErrorCodeSchema } from './session'
import { AuthStatusSchema } from './user'

/**
 * 校园认证（#68）。教育邮箱验证码路径的对外协议。
 *
 * Provider 可替换（`EmailVerificationProvider`），但域白名单是产品规则而非实现细节，
 * 因此冻结在契约里：不是任何邮箱都能发起校园认证。
 */
export const CAMPUS_EMAIL_DOMAIN = '@gzasc.edu.cn'

export const CampusEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.string().min(1).max(64))
  .refine((value) => value.endsWith(CAMPUS_EMAIL_DOMAIN), {
    error: `必须是 ${CAMPUS_EMAIL_DOMAIN} 结尾的教育邮箱`,
  })

export type CampusEmail = z.infer<typeof CampusEmailSchema>

/** 6 位数字验证码。仅用于请求入参校验，格式不对直接 422，不给验证服务 500 的机会。 */
export const VerificationCodeSchema = z.string().regex(/^\d{6}$/, '验证码必须是 6 位数字')

export type VerificationCode = z.infer<typeof VerificationCodeSchema>

export const SendCodeRequestSchema = z.strictObject({
  email: CampusEmailSchema,
})

export type SendCodeRequest = z.infer<typeof SendCodeRequestSchema>

/** 发码响应只表示「已受理」，防探测不给额外信息。 */
export const SendCodeResponseSchema = z.object({ sent: z.literal(true) })

export type SendCodeResponse = z.infer<typeof SendCodeResponseSchema>

export const VerifyCodeRequestSchema = z.strictObject({
  email: CampusEmailSchema,
  code: VerificationCodeSchema,
})

export type VerifyCodeRequest = z.infer<typeof VerifyCodeRequestSchema>

/**
 * 认证状态页数据。邮箱脱敏规则固定在这里（`g***@gzasc.edu.cn`）：
 * 完整邮箱只属于绑定者本人，但状态页属于本人可见面，因此给首字符 + *** + 域名。
 */
export const VerificationStatusSchema = z.object({
  authStatus: AuthStatusSchema,
  verifiedAt: z.iso.datetime().nullable(),
  /** 未绑定为 null；已绑定返回脱敏形式，完整邮箱永不出 API。 */
  maskedEmail: z.string().nullable(),
})

export type VerificationStatus = z.infer<typeof VerificationStatusSchema>

/**
 * 校园认证域错误码。认证域既有错误码在 `session.ts`，这里的取值只属于验证码流程。
 */
export const VerificationErrorCodeSchema = z.enum([
  'EMAIL_ALREADY_BOUND',
  'RATE_LIMITED',
  'CODE_EXPIRED',
  'CODE_INVALID',
  'CODE_CONSUMED',
  'TOO_MANY_ATTEMPTS',
  'ALREADY_VERIFIED',
])

export type VerificationErrorCode = z.infer<typeof VerificationErrorCodeSchema>

/** 认证域完整错误码取值 = 会话子域 + 校园认证子域。auth 模块 errors.ts 用它收窄。 */
export const AuthErrorCodeAllSchema = z.enum([
  ...AuthErrorCodeSchema.options,
  ...VerificationErrorCodeSchema.options,
] as [string, ...string[]])

export type AuthErrorCodeAll = z.infer<typeof AuthErrorCodeAllSchema>

/** `g***@gzasc.edu.cn`：本地部分只留首字符（空本地不可能，min(1) 保证）。 */
export function maskCampusEmail(email: string): string {
  const at = email.indexOf('@')
  if (at < 1) return '***'
  return `${email.slice(0, 1)}***${email.slice(at)}`
}
