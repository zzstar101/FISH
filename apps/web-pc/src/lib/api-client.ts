import { ApiErrorSchema } from '@fish/contracts/system/error'

/**
 * 契约里的错误信封（`{ error: { code, message } }`）。所有非 2xx 响应都解析成它，
 * 调用方只依赖 `code` 做分支，不再各自判断 `res.ok` 或解析不同形状。
 */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * 契约冻结的「跳登录」判据：**401 且 code 为 `UNAUTHENTICATED`**。
 * 裸 401 不算 —— `/auth/login` 的 401 是 `INVALID_CREDENTIALS`，属于登录表单的行内错误。
 */
export function isUnauthenticatedError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401 && error.code === 'UNAUTHENTICATED'
}

/**
 * 统一请求入口。只接受相对路径（`/auth/login` 这样、不含 `/api` 前缀），
 * 对外拼成 `/api/...`，由 Vite 代理去掉前缀转发到 API（architecture.md §5.1）。
 *
 * 同源部署，cookie 自动携带，因此不需要 `credentials`。
 */
export async function apiRequest(path: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers)
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }

  const response = await fetch(`/api${path}`, { ...init, headers })

  if (response.status === 204) return null

  const payload: unknown = await response.json().catch(() => null)

  if (!response.ok) {
    const parsed = ApiErrorSchema.safeParse(payload)
    throw parsed.success
      ? new ApiError(parsed.data.error.code, response.status, parsed.data.error.message)
      : new ApiError('INTERNAL_ERROR', response.status, '请求失败，请稍后重试')
  }

  return payload
}
