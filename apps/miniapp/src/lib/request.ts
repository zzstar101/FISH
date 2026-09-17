/**
 * 统一请求入口。
 *
 * 与 Web 端 `apps/web/src/lib/api-client.ts` **同一套契约语义**，差异只有两处，都是平台决定的：
 * 1. 小程序没有同源代理，必须拼绝对地址（`API_BASE`）；
 * 2. 小程序不会自动带 cookie，登录态手动放进 `Cookie` 头（见 `./session`）。
 *
 * 调用方只依赖 `ApiError.code` 做分支，不各自判断 `statusCode`、也不解析不同形状。
 */

import { ApiErrorSchema } from '@fish/contracts/system/error'
import Taro from '@tarojs/taro'
import { API_BASE } from './api-base'
import { clearSession, pickSessionCookie, saveSession, sessionCookieHeader } from './session'

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

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  /** 查询参数；值为 undefined 的键会被跳过 */
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
}

/** 把 query 拼成 `?a=1&b=2`，空对象返回空串 */
function buildQuery(query: RequestOptions['query']): string {
  if (!query) return ''
  const parts: string[] = []
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  }
  return parts.length > 0 ? `?${parts.join('&')}` : ''
}

/**
 * 发一次请求并返回**未解析**的响应体。
 *
 * 之所以不在这里 parse 成具体契约类型：每个域的形状不同（列表 / 详情 / 空 204），
 * 由各自的 `api.ts` 用对应 schema 收口，这里只负责传输、错误信封与登录态。
 */
export async function apiRequest(path: string, options: RequestOptions = {}): Promise<unknown> {
  const header: Record<string, string> = { 'content-type': 'application/json' }
  const cookie = sessionCookieHeader()
  if (cookie) header.Cookie = cookie

  const response = await Taro.request({
    url: `${API_BASE}${path}${buildQuery(options.query)}`,
    method: options.method ?? 'GET',
    header,
    data: options.body === undefined ? undefined : options.body,
  })

  // 登录成功会下发新的会话 cookie，这里接住并持久化
  const issued = pickSessionCookie(response.cookies)
  if (issued) saveSession(issued)

  const { statusCode } = response

  // 204 无正文（例如 `POST /auth/logout`）
  if (statusCode === 204) return null

  const payload: unknown = response.data

  if (statusCode < 200 || statusCode >= 300) {
    const parsed = ApiErrorSchema.safeParse(payload)
    if (parsed.success) {
      // 会话失效就地清掉，避免后续请求一直带着一个已废弃的 cookie
      if (statusCode === 401 && parsed.data.error.code === 'UNAUTHENTICATED') clearSession()
      throw new ApiError(parsed.data.error.code, statusCode, parsed.data.error.message)
    }
    throw new ApiError('INTERNAL_ERROR', statusCode, '请求失败，请稍后重试')
  }

  return payload
}
