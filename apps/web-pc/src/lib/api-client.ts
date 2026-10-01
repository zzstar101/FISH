import { type ApiErrorDetail, ApiErrorSchema } from '@fish/contracts/system/error'
import { currentSessionGeneration } from './session-cache'

/**
 * 契约里的错误信封（`{ error: { code, message, details?, retryAfterSeconds? } }`）。
 * 所有非 2xx 响应都解析成它，调用方只依赖 `code` 做分支，不再各自判断 `res.ok`
 * 或解析不同形状。
 */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details?: ApiErrorDetail[],
    readonly retryAfterSeconds?: number,
    readonly sessionGeneration = currentSessionGeneration(),
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * 契约冻结的「跳登录」判据：**401 且 code 为 `UNAUTHENTICATED`**。
 * 裸 401 不算 —— 带业务错误码的 401（例如 `INVALID_CREDENTIALS`）属于页面内错误，不是「未登录」。
 */
export function isUnauthenticatedError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401 && error.code === 'UNAUTHENTICATED'
}

/**
 * 统一请求入口。只接受相对路径（`/me` 这样、不含 `/api` 前缀），
 * 对外拼成 `/api/...`，由 Vite 代理去掉前缀转发到 API（architecture.md §5.1）。
 *
 * 同源部署，cookie 自动携带，因此不需要 `credentials`。
 */
export async function apiRequest(path: string, init: RequestInit = {}): Promise<unknown> {
  const { payload } = await apiRequestWithResponse(path, init)
  return payload
}

/**
 * 与 `apiRequest` 相同，但把原始 `Response` 一并返回。
 *
 * 推荐 Feed 需要读响应头里的 `x-anonymous-session-id`（服务端可能在客户端没带或
 * 带的值不被认时补发），而 `apiRequest` 只给 payload。错误处理只保留这一份。
 */
export async function apiRequestWithResponse(
  path: string,
  init: RequestInit = {},
): Promise<{ payload: unknown; response: Response }> {
  const requestGeneration = currentSessionGeneration()
  const headers = new Headers(init.headers)
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }

  const response = await fetch(`/api${path}`, { ...init, headers })

  if (response.status === 204) return { payload: null, response }

  const payload: unknown = await response.json().catch(() => null)

  if (!response.ok) {
    const parsed = ApiErrorSchema.safeParse(payload)
    throw parsed.success
      ? new ApiError(
          parsed.data.error.code,
          response.status,
          parsed.data.error.message,
          parsed.data.error.details,
          parsed.data.error.retryAfterSeconds,
          requestGeneration,
        )
      : new ApiError(
          'INTERNAL_ERROR',
          response.status,
          '请求失败，请稍后重试',
          undefined,
          undefined,
          requestGeneration,
        )
  }

  return { payload, response }
}
