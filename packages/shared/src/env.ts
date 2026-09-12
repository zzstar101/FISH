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

/** 服务端（api / worker）启动时统一校验环境变量，缺项直接失败而不是带病运行。 */
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
