import { z } from 'zod'

const LegacyMediaAuditEnvSchema = z.object({
  /** 关掉后 worker 不再投递新补审 job；已在队列里的 job 仍会执行完。 */
  LEGACY_MEDIA_AUDIT_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  /** 每轮投递的补审 job 数。 */
  LEGACY_MEDIA_AUDIT_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  LEGACY_MEDIA_AUDIT_INTERVAL_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(30_000),
  LEGACY_MEDIA_AUDIT_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  LEGACY_MEDIA_AUDIT_RETRY_DELAY_MS: z.coerce.number().int().min(0).max(3_600_000).default(60_000),
  LEGACY_MEDIA_AUDIT_MAX_IMAGE_BYTES: z.coerce
    .number()
    .int()
    .min(1_024)
    .max(10_000_000)
    .default(5_000_000),
})

export type LegacyMediaAuditEnv = {
  enabled: boolean
  batchSize: number
  intervalMs: number
  maxAttempts: number
  retryDelayMs: number
  maxImageBytes: number
}

/**
 * #694 M8 worker 补审的批次/速率配置。全部有默认值，不配置也能跑；
 * 五个变量只影响 worker，不改变 API 的审核策略号。
 */
export function loadLegacyMediaAuditEnv(
  source: Record<string, string | undefined> = process.env,
): LegacyMediaAuditEnv {
  const result = LegacyMediaAuditEnvSchema.safeParse(source)
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`环境变量校验失败（参考 .env.example）：\n${detail}`)
  }
  return {
    enabled: result.data.LEGACY_MEDIA_AUDIT_ENABLED,
    batchSize: result.data.LEGACY_MEDIA_AUDIT_BATCH_SIZE,
    intervalMs: result.data.LEGACY_MEDIA_AUDIT_INTERVAL_MS,
    maxAttempts: result.data.LEGACY_MEDIA_AUDIT_MAX_ATTEMPTS,
    retryDelayMs: result.data.LEGACY_MEDIA_AUDIT_RETRY_DELAY_MS,
    maxImageBytes: result.data.LEGACY_MEDIA_AUDIT_MAX_IMAGE_BYTES,
  }
}
