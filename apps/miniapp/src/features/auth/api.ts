/**
 * 认证域 API（登录 / 注册 / 当前用户 / 退出）。
 *
 * 契约是「学号 + 密码 + 会话 cookie」（`packages/contracts/src/auth/session.ts`），
 * 不是「手机号 + 验证码」。cookie 的存取由 `@/lib/session` 负责，
 * `apiRequest` 已在响应里接住 `Set-Cookie`，调用方不用管。
 *
 * 这里只做「发请求 + 用契约 schema 收口」，不吞错误码：
 * 哪些码该翻成哪个字段的行内错误，是 UI 的事（见 `./store` 与登录 / 注册页）。
 */
import {
  AuthResponseSchema,
  type LoginRequest,
  type RegisterRequest,
} from '@fish/contracts/auth/session'
import type { Me } from '@fish/contracts/auth/user'
import { apiRequest } from '@/lib/request'

/** 登录成功返回当前用户；会话 cookie 由 `apiRequest` 落盘 */
export async function login(input: LoginRequest): Promise<Me> {
  const payload = await apiRequest('/auth/login', { method: 'POST', body: input })
  return AuthResponseSchema.parse(payload).user
}

/** 注册即登录（契约第 1 节）：响应体与 `/me` 同构，成功后不必再打一次 `/auth/login` */
export async function register(input: RegisterRequest): Promise<Me> {
  const payload = await apiRequest('/auth/register', { method: 'POST', body: input })
  return AuthResponseSchema.parse(payload).user
}

/**
 * 当前登录用户。
 *
 * 未登录时后端返回 401 `UNAUTHENTICATED`：`bootstrapAuth()` 据此判定「会话真的失效了」
 * 并清本地凭据（网络不可达则保留凭据），所以这个错误码必须原样透出、不能在这里吞。
 */
export async function fetchMe(): Promise<Me> {
  const payload = await apiRequest('/me')
  return AuthResponseSchema.parse(payload).user
}

/** 退出：后端清会话（204）。本地会话由 `signOut()` 负责清 */
export async function logout(): Promise<void> {
  await apiRequest('/auth/logout', { method: 'POST' })
}
