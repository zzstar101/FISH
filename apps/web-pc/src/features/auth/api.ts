import { AuthResponseSchema } from '@fish/contracts/auth/session'
import type { Me } from '@fish/contracts/auth/user'
import { apiRequest } from '../../lib/api-client'

export async function logout(): Promise<void> {
  await apiRequest('/auth/logout', { method: 'POST' })
}

/**
 * `GET /me` 的响应是 `{ user: Me }`（#3 冻结契约第 1 节），进 UI 前先过一遍契约，
 * 后端形状漂移会在数据进入应用之前就暴露。
 */
export async function fetchMe(): Promise<Me> {
  return AuthResponseSchema.parse(await apiRequest('/me')).user
}
