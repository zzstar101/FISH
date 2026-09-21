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

/**
 * API 专属面交码签名密钥（#70）。
 *
 * 6 位码与 QR token 在 DB 里只存带此密钥的 HMAC，明文不落库。参照 `MAIL_TRANSPORT`
 * 的同一拆分原则**不进共享 ServerEnv**：worker 不做 HMAC，高敏感密钥不扩散到
 * 不需要它的进程。强度下限 32 字符——泄漏等同可离线伪造任意面交码，与数据库同等敏感。
 */
export type MeetupTokenEnv = { MEETUP_TOKEN_SECRET: string }

export function loadMeetupTokenEnv(
  source: Record<string, string | undefined> = process.env,
): MeetupTokenEnv {
  const secret = source.MEETUP_TOKEN_SECRET
  if (!secret || secret.length < 32) {
    throw new Error(
      '环境变量校验失败：MEETUP_TOKEN_SECRET 必须配置且不少于 32 字符（泄漏等同可离线伪造任意面交码）',
    )
  }
  return { MEETUP_TOKEN_SECRET: secret }
}

/**
 * API 专属 AI 润色上游配置（#141）。
 *
 * `AI_POLISH_TRANSPORT` **无默认值**：必须显式声明 `stub` 或 `live`。默认 stub 会让生产静默
 * 返回假文案，默认 live 会让"没配"看起来像"配错了"，所以缺失即启动失败。参照
 * `MAIL_TRANSPORT` / `MEETUP_TOKEN_SECRET` 的同一拆分原则**不进共享 ServerEnv**：
 * worker 不调上游，上游密钥不扩散到不需要它的进程。
 *
 * `AI_POLISH_BASE_URL` 两种 transport 都必填：stub 也是真 HTTP 服务
 * （`apps/api/scripts/ai-polish-stub.ts`），没有"进程内假实现"这种回退路径。
 */
export type AiPolishEnv =
  | { transport: 'stub'; baseUrl: string }
  | { transport: 'live'; baseUrl: string; apiKey: string; model: string }

export function loadAiPolishEnv(
  source: Record<string, string | undefined> = process.env,
): AiPolishEnv {
  const transport = source.AI_POLISH_TRANSPORT
  const baseUrl = source.AI_POLISH_BASE_URL
  if (transport === 'stub') {
    if (!baseUrl) {
      throw new Error(
        '环境变量校验失败：AI_POLISH_TRANSPORT=stub 必须配置 AI_POLISH_BASE_URL（指向 apps/api/scripts/ai-polish-stub.ts）',
      )
    }
    return { transport: 'stub', baseUrl }
  }
  if (transport === 'live') {
    const apiKey = source.AI_POLISH_API_KEY
    const model = source.AI_POLISH_MODEL
    if (!baseUrl || !apiKey || !model) {
      throw new Error(
        '环境变量校验失败：AI_POLISH_TRANSPORT=live 必须同时配置 AI_POLISH_BASE_URL / AI_POLISH_API_KEY / AI_POLISH_MODEL',
      )
    }
    return { transport: 'live', baseUrl, apiKey, model }
  }
  throw new Error(
    '环境变量校验失败：AI_POLISH_TRANSPORT 必须显式设置为 stub 或 live（无默认值，不允许静默回退）',
  )
}
