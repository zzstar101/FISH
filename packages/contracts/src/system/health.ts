import { z } from 'zod'

/**
 * 基础设施级协议（非业务 domain）。
 * 业务 Contract 由对应业务 Issue 在其 domain 目录下定义，本 Issue 不预置。
 */
export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  timestamp: z.iso.datetime(),
  db: z.object({
    status: z.enum(['up', 'down']),
    latencyMs: z.number().nonnegative(),
  }),
})

export type HealthResponse = z.infer<typeof HealthResponseSchema>
