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
   * 邮件投递环境（#68）：`production` 必须配齐 Resend 两项，否则启动失败；
   * 其余值（development/test，默认 development）走本地 dev outbox。
   */
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_FROM: z.string().min(1).optional(),
})

export type ServerEnv = z.infer<typeof ServerEnvSchema>

/**
 * 服务端（api / worker）启动时统一校验环境变量，缺项直接失败而不是带病运行。
 *
 * 跨字段校验：`NODE_ENV=production` 时 Resend 配置必须齐全（#68 评审 P1-3：
 * 生产缺配置要启动失败，不允许静默回退 dev outbox）。
 */
export function loadServerEnv(source: Record<string, string | undefined> = process.env): ServerEnv {
  const result = ServerEnvSchema.safeParse(source)
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`环境变量校验失败（参考 .env.example）：\n${detail}`)
  }

  const env = result.data
  if (env.NODE_ENV === 'production' && (!env.RESEND_API_KEY || !env.RESEND_FROM)) {
    throw new Error(
      '环境变量校验失败：production 环境必须配置 RESEND_API_KEY 与 RESEND_FROM（邮件投递），不能回退到 dev outbox',
    )
  }
  return env
}
