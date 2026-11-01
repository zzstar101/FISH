/**
 * 认证域 API（微信登录 / 当前用户 / 退出）。
 *
 * 主身份是「微信 code → 会话」（`packages/contracts/src/auth/wechat.ts`）；
 * 学号 + 密码那条契约（`packages/contracts/src/auth/session.ts`）**只留在 PC Web 端**
 * （见 `apps/web-pc/src/routes/login.tsx`），小程序侧已无入口。cookie 的存取由
 * `@/lib/session` 负责，`apiRequest` 已在响应里接住 `Set-Cookie`，调用方不用管。
 *
 * 这里只做「发请求 + 用契约 schema 收口」，不吞错误码：
 * 哪些码该翻成什么文案，是 UI 的事（见 `./store` 与登录页）。
 */

import { ACCOUNT_DELETION_ROUTES } from '@fish/contracts/account-deletion/routes'
import {
  ACCOUNT_DELETION_CONFIRMATION_PHRASE,
  type AccountDeletionRequestResponse,
  AccountDeletionRequestResponseSchema,
  type AccountDeletionStatus,
  AccountDeletionStatusSchema,
} from '@fish/contracts/account-deletion/schema'
import { type PhoneBindResponse, PhoneBindResponseSchema } from '@fish/contracts/auth/phone'
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

/**
 * 手机号绑定的请求超时（毫秒）。
 *
 * 必须**大于**服务端最坏耗时（`apps/api/src/modules/auth/wechat-phone.ts`：取 token 5s +
 * 换号 5s，凭证失效再各一次 ≈ 20s）。用全局的 15s 会让客户端先超时、报「网络异常」，
 * 而号码其实已经落库 —— 用户看到的失败与服务端事实不一致，还会诱发重复授权。
 */
const PHONE_BIND_TIMEOUT_MS = 25_000

/**
 * 手机号绑定（#204）：只上报 `<Button open-type="getPhoneNumber">` 给的一次性 `code`。
 *
 * 契约冻结（`packages/contracts/src/auth/phone.ts`）：`encryptedData` / `iv` / 明文号码
 * **不出端**，服务端拿 code 调微信 `getuserphonenumber` 换号，只回派生态 `maskedPhone`。
 * 已绑定时再调一次是**覆盖**（换绑），不是冲突。
 * 错误码原样透出由设置页翻译（`./phone` 的 `phoneBindFailureMessage`）：422
 * `PHONE_CODE_INVALID` / 422 `PHONE_NUMBER_UNSUPPORTED` / 409 `PHONE_ALREADY_BOUND` /
 * 502 `PHONE_UPSTREAM_FAILED` / 503 `WECHAT_DISABLED`。
 */
export async function bindPhone(code: string): Promise<PhoneBindResponse> {
  return PhoneBindResponseSchema.parse(
    await apiRequest('/auth/phone/bind', {
      method: 'POST',
      body: { code },
      timeout: PHONE_BIND_TIMEOUT_MS,
    }),
  )
}

/**
 * 扫码登录确认（#197）：把登录票据绑到**当前会话用户**。
 *
 * 契约 `packages/contracts/src/auth/scan.ts`：204 无响应体；`ticket` 是 22 字符
 * base64url（URL 安全字符集，无需编码）。失败错误码原样透出，由确认页翻译：
 * 404 `SCAN_TICKET_INVALID`（不存在 / 过期 / 已兑换）与 409 `SCAN_TICKET_CONFLICT`
 * （已被另一个账号确认）。会话 cookie 由 `apiRequest` 统一携带。
 */
export async function confirmScanTicket(ticket: string): Promise<void> {
  await apiRequest(`/auth/wechat/scan/ticket/${ticket}/confirm`, { method: 'POST' })
}

/**
 * 账号注销（#464）：三条方法落在同一个 URL 上，资源就是「我的注销申请」这一条状态。
 *
 * 注销态**不在** `Me` 里（#3 契约冻结），所以注销页要单独读这里。冷静期内其它会话会被
 * 撤销、当前会话保留 —— 因此端上不会因为申请注销就被踢回登录页，撤回入口仍然有效。
 */
export async function fetchAccountDeletionStatus(): Promise<AccountDeletionStatus> {
  return AccountDeletionStatusSchema.parse(await apiRequest(ACCOUNT_DELETION_ROUTES.status))
}

/**
 * 申请注销（幂等：冷静期内重复提交回 200 与既有状态，**不重置 7 天计时**）。
 *
 * 固定词取自契约常量；页面要求用户手输一遍才允许提交，服务端仍会独立校验。
 */
export async function requestAccountDeletion(): Promise<AccountDeletionRequestResponse> {
  return AccountDeletionRequestResponseSchema.parse(
    await apiRequest(ACCOUNT_DELETION_ROUTES.status, {
      method: 'POST',
      body: { confirmation: ACCOUNT_DELETION_CONFIRMATION_PHRASE },
    }),
  )
}

/** 撤回注销申请（幂等：不在冷静期时回 200 与当前状态）。撤回**不恢复商品上架**。 */
export async function withdrawAccountDeletion(): Promise<AccountDeletionStatus> {
  return AccountDeletionStatusSchema.parse(
    await apiRequest(ACCOUNT_DELETION_ROUTES.status, { method: 'DELETE' }),
  )
}
