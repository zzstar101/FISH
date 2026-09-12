import { z } from 'zod'

/**
 * 一条字段级校验错误。`field` 是点号路径（`title`、`images.2`），前端据此把错误定位到输入框；
 * 数组下标也用点号（`objectKeys.1`），与 Zod 的 issue path 拼接方式一致。
 */
export const ApiErrorDetailSchema = z.object({ field: z.string(), message: z.string() })

export type ApiErrorDetail = z.infer<typeof ApiErrorDetailSchema>

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
     * 字段级校验错误，只在 `VALIDATION_FAILED` 时出现（#6 冻结契约 §3）；
     * 可选是刻意的：auth / wishes 的响应不带它，加这个字段必须保持纯增量，
     * 否则就是替它们改协议。
     */
    details: z.array(ApiErrorDetailSchema).optional(),
  }),
})

export type ApiError = z.infer<typeof ApiErrorSchema>

/**
 * 唯一的错误响应构造入口：所有 domain 都用它，信封形状因此不可能各自漂移。
 *
 * `details` 只在字段级校验失败时传（#6 冻结契约 §3）；不传时响应体与本函数加第三参之前**逐字节相同**
 * —— 既有调用方（auth / health）无需改动。
 */
export function errorBody(code: string, message: string, details?: ApiErrorDetail[]): ApiError {
  return details ? { error: { code, message, details } } : { error: { code, message } }
}

/** 跨 domain 的通用错误码。 */
export const SystemErrorCodeSchema = z.enum(['VALIDATION_FAILED', 'INTERNAL_ERROR'])

export type SystemErrorCode = z.infer<typeof SystemErrorCodeSchema>
