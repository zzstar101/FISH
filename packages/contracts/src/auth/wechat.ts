import { z } from 'zod'
import { AuthResponseSchema } from './session'

/**
 * 微信身份契约（#86 A 节，2026-09-22 产品冻结）。
 *
 * 链路：Miniapp `wx.login()` 拿临时 `code` -> `POST /auth/wechat/session` ->
 * 服务端 code2Session 换 openid/session_key -> `wechat_identities` 映射 ->
 * FISH user -> fish_session（httpOnly cookie）。
 *
 * 安全边界：
 * - 客户端**只**上报 `code`；openid / session_key 是服务端与微信之间的凭据，
 *   任何客户端上报的 openid 都不被信任，响应体里也不回传它们。
 * - 同一 appid + openid 全局唯一映射（DB 唯一索引兜底并发首登幂等）。
 * - logout 只销毁 fish_session，不解绑微信身份。
 */

/** `wx.login()` 返回的临时登录凭证；长度按微信文档上限收口。 */
export const WechatCodeSchema = z.string().min(1).max(64)

/** `.strict()`：多余字段直接 422。 */
export const WechatSessionRequestSchema = z.strictObject({
  code: WechatCodeSchema,
})

export type WechatSessionRequest = z.infer<typeof WechatSessionRequestSchema>

/** 与学号登录同构的响应体：`user` + httpOnly 会话 cookie（由 API 层落 Set-Cookie）。 */
export const WechatSessionResponseSchema = AuthResponseSchema

export type WechatSessionResponse = z.infer<typeof WechatSessionResponseSchema>
