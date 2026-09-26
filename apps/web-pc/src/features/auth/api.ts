import type { LoginRequest, RegisterRequest } from '@fish/contracts/auth/session'
import { AuthResponseSchema } from '@fish/contracts/auth/session'
import type { Me } from '@fish/contracts/auth/user'
import { apiRequest } from '../../lib/api-client'

/**
 * 登录 / 注册 / `GET /me` 三个响应同构，都是 `{ user: Me }`（#3 冻结契约第 1 节），
 * 因此统一在这里校验一次响应体：契约漂移会在数据进入 UI 前就暴露。
 */
function readUser(payload: unknown): Me {
  return AuthResponseSchema.parse(payload).user
}

export async function login(input: LoginRequest): Promise<Me> {
  return readUser(await apiRequest('/auth/login', { method: 'POST', body: JSON.stringify(input) }))
}

export async function register(input: RegisterRequest): Promise<Me> {
  return readUser(
    await apiRequest('/auth/register', { method: 'POST', body: JSON.stringify(input) }),
  )
}

export async function logout(): Promise<void> {
  await apiRequest('/auth/logout', { method: 'POST' })
}

export async function fetchMe(): Promise<Me> {
  return readUser(await apiRequest('/me'))
}
