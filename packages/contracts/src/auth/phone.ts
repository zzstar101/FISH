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
 * - 解绑 / 换绑本期没有入口（见 auth service `bindPhone` 注释），真实
 *   getPhoneNumber 接入前需单开 Issue 冻结规则。
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

/**
 * 绑定入口的失败码（#204）。
 *
 * 公开只出两个码，这是**故意**的取舍：上游 `getPhoneNumber` 有五六种故障姿态
 * （code 无效 / code 已用 / access_token 失效 / 超时 / 上游 5xx / 频控 / 能力未开通），
 * 但端上能做的只有「换一次 code 重试」和「提示稍后再试 / 联系客服」两类动作。
 * 把内部分支逐一暴露成独立错误码，等于让客户端解析服务端实现细节。
 *
 * 真正要守住的约束是**不把平台故障伪装成用户 code 错误**——所以切分点只有一处：
 *
 * - `PHONE_CODE_INVALID`（422）上游明确判定这个 code 不可用（`errcode` 40029 / 40163），
 *   以及 stub / live 解析出的号码不合法。端上应重新触发一次授权拿新 code。
 * - `PHONE_UPSTREAM_UNAVAILABLE`（502）平台侧故障：凭证失效（已在服务端丢弃缓存）、
 *   超时 / 不可达 / 响应畸形 / 其它 `errcode`（频控、系统繁忙、接口未授权……）。
 *   端上重试同一次 code 无意义，应提示稍后再试。
 *
 * 与 #197 取码（`WECHAT_QR_UNAVAILABLE`，同为 502）同一口径：`WECHAT_DISABLED`（503）
 * 专指 transport 未开通，与「能力已开通但平台此刻不可用」不是一回事，端上引导也不同。
 */
export const PhoneErrorCodeSchema = z.enum(['PHONE_CODE_INVALID', 'PHONE_UPSTREAM_UNAVAILABLE'])

export type PhoneErrorCode = z.infer<typeof PhoneErrorCodeSchema>
