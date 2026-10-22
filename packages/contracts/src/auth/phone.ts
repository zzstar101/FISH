import { z } from 'zod'

/**
 * 手机号绑定契约（#86 C 节，2026-09-22 产品冻结）。
 *
 * 链路：Miniapp `<button open-type="getPhoneNumber">` 拿动态 `code` ->
 * `POST /auth/phone/bind` -> 服务端调微信 `phonenumber.getPhoneNumber` 换明文手机号 ->
 * 写 `users.phone`（服务端保存，任何响应不回传明文）。
 *
 * 边界：
 * - 手机号授权失败不能破坏已有微信登录会话（本端点只追加绑定，不动 session）；
 * - `Me` 只回 `phoneBound` / `maskedPhone` 派生态（见 `auth/user.ts`）；
 * - 「哪些动作必须绑定手机号」的权限矩阵由产品另行冻结，本契约不含授权判断；
 * - 同一用户重复提交同一号码 = 幂等成功（200）；号码被**其他**账号占用 = 409
 *   `PHONE_ALREADY_BOUND`；
 * - 失败面三分（#204 起 live 生效），端上引导各不相同：
 *   code 无效 / 过期 / 已用 = 422 `PHONE_CODE_INVALID`；
 *   换取成功但号码不是 11 位大陆号 = 422 `PHONE_NUMBER_UNSUPPORTED`；
 *   上游不可达 / 超时 / 凭证失效重试后仍失败 = 502 `PHONE_UPSTREAM_FAILED`（不破坏会话）；
 * - 解绑 / 换绑本期没有入口（见 auth service `bindPhone` 注释），换绑规则需单开 Issue 冻结。
 */

/** `getPhoneNumber` 动态令牌；长度按微信文档上限收口。 */
export const PhoneCodeSchema = z.string().min(1).max(64)

/** `.strict()`：多余字段直接 422。 */
export const PhoneBindRequestSchema = z.strictObject({
  code: PhoneCodeSchema,
})

export type PhoneBindRequest = z.infer<typeof PhoneBindRequestSchema>

/** 绑定成功响应：只回派生态，不含明文。 */
export const PhoneBindResponseSchema = z.object({
  phoneBound: z.literal(true),
  maskedPhone: z.string(),
})

export type PhoneBindResponse = z.infer<typeof PhoneBindResponseSchema>
