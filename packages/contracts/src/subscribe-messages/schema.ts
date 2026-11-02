import { z } from 'zod'

/**
 * 微信订阅消息 Domain Contract（#462）。前端与 API 只依赖本目录的字段定义。
 *
 * 本域的**数据**不在这里：授权次数与投递行分别是
 * `packages/db/src/schema/subscribe-messages.ts` 的 `subscribe_message_grants`
 * 与 `subscribe_message_deliveries`。这里只有两个端点的请求 / 响应，以及端上必须
 * 认同的几个常量。
 *
 * 三条写进契约的决定：
 *
 * 1. **模板 ID 由服务端下发，端上不硬编码**。`GET /subscribe-messages/config` 返回每个
 *    kind 的模板 ID 或 `null`；`null` 表示该 kind 未开通（没配模板，或
 *    `WECHAT_TRANSPORT != live`），端上**不弹授权**。端上把配置缓存一次即可（模板 ID
 *    只在发版时变，热改由运维改 env 重启 API）。
 * 2. **`requestSubscribeMessage` 只能在用户点击回调里调用**（微信硬约束），所以端上
 *    上报的是「微信返回的原始结果」，服务端只认 `accept`（见 `grantStatus`）。
 * 3. **未开通时写接口 503**（`SUBSCRIBE_MESSAGES_DISABLED`），不是静默记录：能力关闭时
 *    记下多少次"允许"毫无意义，等开通时那些一次性授权早已随模板变更失效。
 */

/** 首批三个订阅模板（Owner 2026-11-01 冻结）。`MATCH` 与 #463 的反馈回复不在首批。 */
export const subscribeMessageKindSchema = z.enum(['CHAT', 'TX', 'REVIEW'])
export type SubscribeMessageKind = z.infer<typeof subscribeMessageKindSchema>

/**
 * 每个 kind 的授权次数上限（Owner 冻结口径）：一次性订阅，用户每「允许」一次 +1，
 * 每发出一条 -1；封顶 50，避免一次连点把计数堆成无意义的大数。
 *
 * **DB 侧有一份等价的 CHECK**（`packages/db/src/schema/subscribe-messages.ts`）：`packages/db`
 * 不能 import `@fish/contracts`（依赖方向是 db 的调用方 → contracts），所以那条 CHECK 里
 * 写的是字面量 50 并注明了本常量。两处一起改。
 */
export const SUBSCRIBE_MESSAGE_GRANT_LIMIT = 50

/** 每个 kind 一个模板 ID；`null` = 未开通。 */
const templatesByKind = <T extends z.ZodTypeAny>(schema: T) =>
  z.object({ CHAT: schema, TX: schema, REVIEW: schema })

/** `GET /subscribe-messages/config` 的响应。模板 ID 不是密钥：端上要拿它调微信接口。 */
export const subscribeMessageConfigSchema = z.object({
  templates: templatesByKind(z.string().min(1).nullable()),
})
export type SubscribeMessageConfig = z.infer<typeof subscribeMessageConfigSchema>

/**
 * `wx.requestSubscribeMessage` 每个模板的返回值。
 *
 * 端上原样上报，服务端**只认 `accept`**：`reject`（用户拒绝）/ `ban`（已封禁）/
 * `filter`（模板被平台过滤）都不加次数。值集来自微信官方文档，多一个未知值就当拒绝处理，
 * 所以这里用 `catch` 而不是 `strict` 白名单——新增一个状态码不该让上报整体 422。
 */
export const subscribeMessageGrantStatusSchema = z
  .enum(['accept', 'reject', 'ban', 'filter'])
  .catch('reject')
export type SubscribeMessageGrantStatus = z.infer<typeof subscribeMessageGrantStatusSchema>

/**
 * `POST /me/subscribe-messages/grants` 的请求体。
 *
 * 一次最多带三个（首批就三个模板）；同一个 kind 重复出现按**最后一次**算——端上会把
 * `requestSubscribeMessage` 的返回值原样摊平上报，重复键只可能是端上 bug，不值得 422。
 */
export const subscribeMessageGrantReportSchema = z.strictObject({
  grants: z
    .array(
      z.strictObject({
        kind: subscribeMessageKindSchema,
        status: subscribeMessageGrantStatusSchema,
      }),
    )
    .min(1)
    .max(3),
})
export type SubscribeMessageGrantReport = z.infer<typeof subscribeMessageGrantReportSchema>

/** 三个 kind 各一次，读起来比 `Record<…>` 少一层可选性（端上不用判 undefined）。 */
const countsByKind = () =>
  z.object({
    CHAT: z.number().int().nonnegative(),
    TX: z.number().int().nonnegative(),
    REVIEW: z.number().int().nonnegative(),
  })

/** `POST /me/subscribe-messages/grants` 的响应：上报后各 kind 的剩余次数。 */
export const subscribeMessageGrantsResponseSchema = z.object({
  remaining: countsByKind(),
})
export type SubscribeMessageGrantsResponse = z.infer<typeof subscribeMessageGrantsResponseSchema>

export type SubscribeMessageRemaining = SubscribeMessageGrantsResponse['remaining']

/**
 * 本 domain 新增的错误码。其余复用 system 的 `VALIDATION_FAILED`（422）与 auth 的
 * `UNAUTHENTICATED`（401）。
 */
export const SubscribeMessageErrorCodeSchema = z.enum([
  /**
   * 503：订阅消息能力未开通（三个模板一个都没配，或 `WECHAT_TRANSPORT != live`）。
   * 端上按"这台手机上没有这个能力"处理即可，不弹提示——它只会在配置被改动的那一刻出现。
   */
  'SUBSCRIBE_MESSAGES_DISABLED',
])
export type SubscribeMessageErrorCode = z.infer<typeof SubscribeMessageErrorCodeSchema>
