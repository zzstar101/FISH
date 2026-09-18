import {
  SendCodeRequestSchema,
  type VerificationStatus,
  VerificationStatusSchema,
  VerifyCodeRequestSchema,
} from '@fish/contracts/auth/verification'
import { apiRequest } from '../../lib/api-client'

/** 认证状态页数据（`GET /auth/verification/status`）。 */
export async function fetchVerificationStatus(): Promise<VerificationStatus> {
  return VerificationStatusSchema.parse(await apiRequest('/auth/verification/status'))
}

/** 发送验证码（`POST /auth/verification/code`）。成功即 `sent: true`。 */
export async function sendVerificationCode(input: { email: string }): Promise<void> {
  const parsed = SendCodeRequestSchema.safeParse(input)
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? '邮箱格式不正确')
  await apiRequest('/auth/verification/code', {
    method: 'POST',
    body: JSON.stringify(parsed.data),
  })
}

/** 提交验证码（`POST /auth/verification/verify`），返回最新认证状态。 */
export async function verifyCampusEmail(input: {
  email: string
  code: string
}): Promise<VerificationStatus> {
  const parsed = VerifyCodeRequestSchema.safeParse(input)
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? '输入不合法')
  return VerificationStatusSchema.parse(
    await apiRequest('/auth/verification/verify', {
      method: 'POST',
      body: JSON.stringify(parsed.data),
    }),
  )
}
