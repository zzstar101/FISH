import {
  CAMPUS_EMAIL_DOMAIN,
  CampusEmailSchema,
  SendCodeRequestSchema,
  SendCodeResponseSchema,
  type VerificationStatus,
  VerificationStatusSchema,
  VerifyCodeRequestSchema,
} from '@fish/contracts/auth/verification'
import { apiRequest } from '../../lib/api-client'

/**
 * 校园认证域 API（#380）：发码 / 校验 / 状态三个端点。
 *
 * 域名白名单、错误码、响应形状全部冻结在 `@fish/contracts/auth/verification` 里，
 * 这里只做「发请求 + 用契约收口」，不吞错误码 —— 哪个码翻成哪句文案是展示层的事
 * （`./messages.ts`）。因此前端**不写死**教育邮箱域名，白名单改了这里自动跟随。
 *
 * 契约包未导出这三个路径的常量（只有 HTTP 端点本身），与小程序端保持同一份字面量。
 */
const VERIFICATION_ROUTES = {
  code: '/auth/verification/code',
  verify: '/auth/verification/verify',
  status: '/auth/verification/status',
} as const

/**
 * 输入框里的邮箱 → 契约要求的形态。
 *
 * `CampusEmailSchema` 是 `z.email().trim().toLowerCase()` 链：`.email()` 对**原始值**
 * 做格式 check 且**先于** `.trim()` 生效，所以带尾随空格的地址会被 schema 直接拒掉。
 * 统一在 API 入口 trim，调用方不必各自记住这件事（忘了就会在发请求前抛 ZodError，
 * 被页面当成网络失败）。大小写不用管：schema 自己 `toLowerCase()`。
 */
function normalizeEmail(email: string): string {
  return email.trim()
}

/**
 * 是否为本校教育邮箱。走契约的 `CampusEmailSchema`（精确域白名单），
 * 不在这里复制一份域名正则 —— 子域（`school.gzasc.edu.cn`）、双 `@`、含空格
 * 这些异常形态由契约统一拦下，页面在**提交前**就能给出行内提示。
 */
export function isCampusEmail(email: string): boolean {
  return CampusEmailSchema.safeParse(normalizeEmail(email)).success
}

/**
 * 域名不符时的行内文案。逐字等于契约 refine 的 message（服务端 422 的 details 也是它），
 * 端上预检因此不会与服务端给出两套说法；用例把它钉在契约上，改文案会红。
 */
export const CAMPUS_EMAIL_REQUIREMENT = `必须是 ${CAMPUS_EMAIL_DOMAIN} 教育邮箱`

/** 发码（`POST /auth/verification/code`）：响应只表示「已受理」，不含验证码。 */
export async function sendVerificationCode(email: string): Promise<void> {
  const body = SendCodeRequestSchema.parse({ email: normalizeEmail(email) })
  SendCodeResponseSchema.parse(
    await apiRequest(VERIFICATION_ROUTES.code, { method: 'POST', body: JSON.stringify(body) }),
  )
}

/** 校验（`POST /auth/verification/verify`）：成功后返回权威认证状态（含脱敏邮箱）。 */
export async function verifyCampusCode(email: string, code: string): Promise<VerificationStatus> {
  const body = VerifyCodeRequestSchema.parse({ email: normalizeEmail(email), code })
  return VerificationStatusSchema.parse(
    await apiRequest(VERIFICATION_ROUTES.verify, { method: 'POST', body: JSON.stringify(body) }),
  )
}

/** 认证状态（`GET /auth/verification/status`）：含脱敏邮箱与认证时间，永不返回明文邮箱。 */
export async function fetchVerificationStatus(): Promise<VerificationStatus> {
  return VerificationStatusSchema.parse(await apiRequest(VERIFICATION_ROUTES.status))
}
