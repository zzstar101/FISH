import { z } from 'zod'

const ServerEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  API_PORT: z.coerce.number().int().positive().default(3000),
  WEB_ORIGIN: z.string().min(1),
  S3_ENDPOINT: z.string().min(1),
  S3_REGION: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_PUBLIC_URL: z.string().min(1),
  /**
   * 面交交易码（#70）的 HMAC 签名密钥：6 位码与 QR token 只存 HMAC，明文不落库。
   * 泄漏 = 可离线伪造任意面交码，与数据库同等敏感；无默认值，缺配置启动失败。
   * 与 S3 密钥同属共享 ServerEnv：api / worker 都会加载它（worker 不做 HMAC，
   * 但部署层需统一注入）。
   */
  MEETUP_TOKEN_SECRET: z.string().min(1),
})

export type ServerEnv = z.infer<typeof ServerEnvSchema>

/**
 * 服务端（api / worker）启动时统一校验环境变量，缺项直接失败而不是带病运行。
 */
export function loadServerEnv(source: Record<string, string | undefined> = process.env): ServerEnv {
  const result = ServerEnvSchema.safeParse(source)
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`环境变量校验失败（参考 .env.example）：\n${detail}`)
  }
  return result.data
}

/**
 * API 专属邮件投递配置（#68 评审二轮 P1-2）。
 *
 * `MAIL_TRANSPORT` **无默认值**：部署层必须显式声明 `outbox` 或 `resend`，
 * 忘记注入不会静默降级成 dev 投递。选 `resend` 时 Resend 两项必须齐全。
 * 只在 API 进程校验（worker 不发邮件），避免 Resend 密钥扩散到 worker。
 */
export type MailTransportEnv =
  | { transport: 'outbox' }
  | { transport: 'resend'; resendApiKey: string; resendFrom: string }

export function loadMailTransportEnv(
  source: Record<string, string | undefined> = process.env,
): MailTransportEnv {
  const mode = source.MAIL_TRANSPORT
  if (mode === 'outbox') return { transport: 'outbox' }
  if (mode === 'resend') {
    const apiKey = source.RESEND_API_KEY
    const from = source.RESEND_FROM
    if (!apiKey || !from) {
      throw new Error(
        '环境变量校验失败：MAIL_TRANSPORT=resend 必须同时配置 RESEND_API_KEY 与 RESEND_FROM',
      )
    }
    return { transport: 'resend', resendApiKey: apiKey, resendFrom: from }
  }
  throw new Error(
    '环境变量校验失败：MAIL_TRANSPORT 必须显式设置为 outbox 或 resend（不允许静默降级投递）',
  )
}
