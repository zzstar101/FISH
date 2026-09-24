/**
 * 认证域 API（微信登录 / 当前用户 / 退出）。
 *
 * 主身份是「微信 code → 会话」（`packages/contracts/src/auth/wechat.ts`）；
 * 学号 + 密码那条契约（`packages/contracts/src/auth/session.ts`）**只留在 web 端**
 * （见 `apps/web/src/routes/login.tsx`），小程序侧已无入口。cookie 的存取由
 * `@/lib/session` 负责，`apiRequest` 已在响应里接住 `Set-Cookie`，调用方不用管。
 *
 * 这里只做「发请求 + 用契约 schema 收口」，不吞错误码：
 * 哪些码该翻成什么文案，是 UI 的事（见 `./store` 与登录页）。
 */
import { AuthResponseSchema } from '@fish/contracts/auth/session'
import type { Me } from '@fish/contracts/auth/user'
import { WechatSessionResponseSchema } from '@fish/contracts/auth/wechat'
import { apiRequest } from '@/lib/request'

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

/**
 * 微信一键登录（#86 A 节）：只上报 `wx.login()` 的一次性 code，换 FISH 会话。
 *
 * 契约冻结（`packages/contracts/src/auth/wechat.ts`）：客户端**不上报也不接收** openid /
 * session_key，服务端是唯一与微信换凭证的一方；同一微信用户重复登录映射到同一账号。
 * 错误码原样透出由页面翻译：503 `WECHAT_DISABLED`（后端未开通）与
 * 401 `WECHAT_CODE_INVALID`（code 无效/过期）在登录页给不同文案。
 */
export async function wechatSignIn(code: string): Promise<Me> {
  const payload = await apiRequest('/auth/wechat/session', { method: 'POST', body: { code } })
  return WechatSessionResponseSchema.parse(payload).user
}
