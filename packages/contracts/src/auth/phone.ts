import { z } from 'zod'

/**
 * 手机号绑定契约（#86 C 节，2026-09-22 产品冻结）。
 *
 * 链路：Miniapp `<button open-type="getPhoneNumber">` 拿动态 `code` ->
 * `POST /auth/phone/bind` -> 服务端调微信 `phonenumber.getUserPhoneNumber` 换明文手机号 ->
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
 * - 解绑没有通路（`users.phone` 不会被清空）；**换绑**目前是「再绑一次不同号码即覆盖」——
 *   没有守卫也没有确认步，规则待 #86 冻结，本契约不承诺换绑语义（见 auth service `bindPhone`）。
 */

/**
 * 端上 `POST /auth/phone/bind` 的请求超时（毫秒）。
 *
 * 这个数必须**跨端对齐**，所以放在契约里（同 `ACCOUNT_DELETION_COOLING_OFF_DAYS` 的做法）：
 * - 服务端最坏耗时 ≈20s：取 `access_token` 5s + 换号 5s，凭证失效再各一次
 *   （重试见 `apps/api/src/modules/auth/wechat-phone.ts`，两段上游超时都是
 *   `WECHAT_PLATFORM_TIMEOUT_MS` = 5s）；
 * - 服务端连接超时（`Bun.serve` 的 `idleTimeout`，见 `apps/api/src/index.ts`）取 22s，
 *   覆盖上面 20s 再加本地写库；低于它的话客户端会收到 ECONNRESET，而号码其实已经落库；
 * - 所以客户端必须比两者都长：25s。
 *
 * 三者的大小关系由 `apps/api/src/modules/auth/phone-bind-budget.test.ts` 钉住（含真实
 * `Bun.serve` 用例），改动任何一端都会在那里红。
 */
export const PHONE_BIND_CLIENT_TIMEOUT_MS = 25_000

/**
 * `getPhoneNumber` 一次性动态令牌。
 *
 * 长度上限**刻意放宽**（512）而不是按某个「官方上限」收口：官方接口页没有给 code 长度，
 * 而这个上限在 live 生效后会变成线上硬门禁——收得太紧会让所有真实授权都 422。真正把关
 * 归属的是上游换取结果，不是这里的长度。
 */
export const PhoneCodeSchema = z.string().min(1).max(512)

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
