/**
 * 校园认证域 API（#68 后端，三个端点整段挂在 `requireAuth` 之下，见
 * `apps/api/src/modules/auth/router.ts`）：发码 / 校验 / 状态。
 *
 * 域名白名单、错误码、响应形状全部冻结在 `@fish/contracts/auth/verification`，
 * 这里只做「发请求 + 用契约收口」，不吞错误码：哪个码翻成哪句行内文案是页面的事。
 * 前端因此**不写死教育邮箱域名**（Provider / 白名单可替换）。
 */
// 必须是第一条：在任何契约（zod schema）模块被求值之前关掉 zod 的 JIT，见该模块的说明
import '@/lib/zod-jitless'
import {
  CAMPUS_EMAIL_DOMAIN,
  CampusEmailSchema,
  SendCodeRequestSchema,
  SendCodeResponseSchema,
  type VerificationStatus,
  VerificationStatusSchema,
  VerifyCodeRequestSchema,
} from '@fish/contracts/auth/verification'
import { apiRequest } from '@/lib/request'

/** 页面文案（placeholder / 行内提示）用同一份白名单域名，避免又写死一个 `@stu.edu.cn`。 */
export { CAMPUS_EMAIL_DOMAIN }

/** 后端路由（契约包未导出校园认证的路径常量，只有 HTTP 端点本身）。 */
const VERIFICATION_ROUTES = {
  code: '/auth/verification/code',
  verify: '/auth/verification/verify',
  status: '/auth/verification/status',
} as const

/**
 * 输入框里的邮箱 → 契约要求的形态。
 *
 * `CampusEmailSchema` 是 `z.email().trim()...`：`.email()` 对**原始值**做格式 check，
 * **先于** `.trim()` 生效，所以带尾随空格的地址会被 schema 直接拒掉（实测
 * `safeParse('user@gzasc.edu.cn ')` → false）。统一在 API 入口 trim，
 * 调用方不必各自记住这件事（忘了就会在发请求前抛 ZodError，被页面当成网络失败）。
 */
function normalizeEmail(email: string): string {
  return email.trim()
}

/**
 * 是否为本校教育邮箱。走契约的 `CampusEmailSchema`（精确域白名单），
 * 不在这里复制一份域名正则 —— 白名单改了页面自动跟着改。
 */
export function isCampusEmail(email: string): boolean {
  return CampusEmailSchema.safeParse(normalizeEmail(email)).success
}

/** 发码（`POST /auth/verification/code`）：仅表示「已受理」，SDK 不暴露验证码。 */
export async function sendVerificationCode(email: string): Promise<void> {
  const body = SendCodeRequestSchema.parse({ email: normalizeEmail(email) })
  const payload = await apiRequest(VERIFICATION_ROUTES.code, { method: 'POST', body })
  SendCodeResponseSchema.parse(payload)
}

/** 校验（`POST /auth/verification/verify`）：成功后返回权威认证状态。 */
export async function verifyCampusCode(email: string, code: string): Promise<VerificationStatus> {
  const body = VerifyCodeRequestSchema.parse({ email: normalizeEmail(email), code })
  const payload = await apiRequest(VERIFICATION_ROUTES.verify, { method: 'POST', body })
  return VerificationStatusSchema.parse(payload)
}

/** 认证状态（`GET /auth/verification/status`）：含脱敏邮箱与认证时间。 */
export async function fetchVerificationStatus(): Promise<VerificationStatus> {
  const payload = await apiRequest(VERIFICATION_ROUTES.status)
  return VerificationStatusSchema.parse(payload)
}
