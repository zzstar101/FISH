import { z } from 'zod'

/**
 * 统一错误信封（非业务协议，与 `system/health.ts` 同属基础设施层）。
 *
 * 所有 domain 的失败响应共用它，避免每个模块自造错误形状；`code` 的具体值域由
 * 各 domain 自己收窄（如 `@fish/contracts/auth/session` 的 `AuthErrorCodeSchema`）。
 */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    /**
     * 字段级校验错误，只在 `VALIDATION_FAILED` 时出现（#6 冻结契约 §3）；`field` 是点号路径
     * （`title`、`images.2`），前端据此把错误定位到输入框。
     *
     * 可选是刻意的：auth / wishes 的响应不带它，加这个字段必须保持纯增量，
     * 否则就是替它们改协议。
     */
    details: z.array(z.object({ field: z.string(), message: z.string() })).optional(),
  }),
})

export type ApiError = z.infer<typeof ApiErrorSchema>

/**
 * 唯一的错误响应构造入口：所有 domain 都用它，信封形状因此不可能各自漂移。
 */
export function errorBody(code: string, message: string): ApiError {
  return { error: { code, message } }
}

/** 跨 domain 的通用错误码。 */
export const SystemErrorCodeSchema = z.enum(['VALIDATION_FAILED', 'INTERNAL_ERROR'])

export type SystemErrorCode = z.infer<typeof SystemErrorCodeSchema>
