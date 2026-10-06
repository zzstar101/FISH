import { z } from 'zod'

/**
 * Account Deletion Domain Contract（Issue #464）。
 *
 * 前端、API 与 worker 只依赖本目录的字段定义。DB 侧的对应形态见
 * `packages/db/src/schema/users.ts` 的 `account_status` 三态与两个时间戳列。
 *
 * ## 为什么状态只在 `/me/account-deletion` 自报，不进 `Me` DTO
 *
 * `MeSchema`（#3 冻结）是登录 / 注册 / `GET /me` 的共用响应。注销态是 #464 的新概念，
 * 塞进去等于改 #3 的契约；而真正需要它的只有注销入口那几个页面。因此保持 `Me` 逐字节不变，
 * 由本域端点自报（服务端内部的写拦截也不需要对外暴露这个字段）。
 *
 * ## 冻结口径（Owner 2026-10-06 确认，见 issue #464 评论）
 *
 * - 7 天冷静期，期间可撤回；申请即撤销**其他**会话、断开 WebSocket、下架在架商品、
 *   拒绝一切写操作（GET 读 / 登出 / 重新登录 / 撤回除外）。
 * - 到期由 worker 执行去标识化：昵称改写为 {@link DELETED_ACCOUNT_NICKNAME}、其余身份字段置
 *   NULL，私域数据真删，交易 / 评价 / 留言 / 聊天 / 审计保留。
 * - 身份唯一键（学号 / 校园邮箱 / 手机号 / 微信 openid）全部释放，同一身份可立即重新注册。
 *
 * ## 后续 seam（#465）
 *
 * 争议拦截**不在本单范围**：资格校验只硬阻塞「未完成交易」与「生效中的 BAN」。
 * #465（交易争议反馈）合入后需要在资格校验处补一条「存在进行中争议」的拒绝分支，
 * 错误码在同枚举内新增 `ACCOUNT_DELETION_BLOCKED_DISPUTE`（与未完成交易同一条通路、
 * 同样在 `message` 里回报原因与对方）。
 */

/**
 * 冷静期天数（产品口径）。
 *
 * 放在契约里而不是 env：它是**用户可见的产品承诺**（「7 天后生效」），端上要拿它算倒计时文案，
 * 服务端要用它算 `purgeScheduledAt`。两边读同一个常量，不存在「端上说 7 天、服务端排 30 天」。
 */
export const ACCOUNT_DELETION_COOLING_OFF_DAYS = 7

/**
 * 二次确认的固定词。
 *
 * 主身份是微信，注销入口没有「重新输入密码」这一步可依赖（微信注册用户没有密码），
 * 所以服务端的显式确认取「固定词精确匹配」这一形状：前端弹窗里让用户手输这五个字，
 * 服务端 `z.literal` 校验。它防的是误触与脚本化的顺手调用，不是防本人（本人本来就有权注销）。
 */
export const ACCOUNT_DELETION_CONFIRMATION_PHRASE = '注销账号'

/**
 * 去标识化后的昵称占位。
 *
 * `users.nickname` 是 `NOT NULL`（不能置 NULL），所以原地改写成这个串：所有读模型
 * （商品卡、留言、聊天、评价、管理端）都直接把昵称透传出来，于是**零跨模块改动**就让全部
 * 历史引用显示为占位，不泄漏原资料。worker 写入、测试断言、端上文案都读这一个常量。
 */
export const DELETED_ACCOUNT_NICKNAME = '已注销用户'

/**
 * 对外可见的注销状态值域。
 *
 * 刻意**不含 `DELETED`**：去标识化完成后凭据（密码 / 手机 / 微信映射 / 学号）已全部清空，
 * 那个账号不可能再通过 `requireAuth`，所以它永远读不到自己的状态。`DELETED` 只存在于
 * 服务端内部（DB 枚举与写守卫的 401 分支）。
 */
export const AccountDeletionStateSchema = z.enum(['ACTIVE', 'DELETION_REQUESTED'])

export type AccountDeletionState = z.infer<typeof AccountDeletionStateSchema>

/**
 * 注销状态（`GET` / `DELETE` 的响应体，也是 `POST` 响应的基座）。
 *
 * `requestedAt` / `purgeScheduledAt` 在 `ACTIVE` 时恒为 `null` —— 与 DB 的 CHECK 约束同一口径
 * （三态与两个时间戳同进同出），不存在「状态是 ACTIVE 但还留着上次申请时间」的行。
 * 「同进同出」这条强约束由 DB 的 CHECK 与 `account-deletion/store.ts` 的写入共同保证；
 * 本 schema 只声明可空性，不重复表达它（否则 `POST` 响应要在 `extend` 之后重建 refine）。
 */
export const AccountDeletionStatusSchema = z.object({
  status: AccountDeletionStateSchema,
  /** 申请时刻；`ACTIVE` 时为 `null`。 */
  requestedAt: z.iso.datetime().nullable(),
  /** 冷静期到期时刻（= 申请时刻 + {@link ACCOUNT_DELETION_COOLING_OFF_DAYS} 天）；`ACTIVE` 时为 `null`。 */
  purgeScheduledAt: z.iso.datetime().nullable(),
})

export type AccountDeletionStatus = z.infer<typeof AccountDeletionStatusSchema>

/**
 * `POST /me/account-deletion` 的响应：状态 + 本次被下架的在架商品数。
 *
 * 只在下架动作**由本次申请触发**时才有意义，所以只出现在 POST 响应里（GET 读状态时无从得知
 * 「哪些商品是当时被注销流程下架的」——我们没有为它加审计列，撤回也不恢复上架）。
 * 端上用它提示「X 件商品已下架，需手动重新上架」。
 */
export const AccountDeletionRequestResponseSchema = AccountDeletionStatusSchema.extend({
  /** 本次申请下架的本人 `ACTIVE` / `RESERVED` 商品数（撤回不恢复上架）。 */
  offlinedListingCount: z.number().int().nonnegative(),
})

export type AccountDeletionRequestResponse = z.infer<typeof AccountDeletionRequestResponseSchema>

/**
 * `POST /me/account-deletion` 的请求体。
 *
 * `.strict()`：多余字段直接 422（与 `RegisterRequestSchema` 同口径）。
 */
export const RequestAccountDeletionSchema = z.strictObject({
  /** 固定词二次确认，必须逐字等于 {@link ACCOUNT_DELETION_CONFIRMATION_PHRASE}。 */
  confirmation: z.literal(ACCOUNT_DELETION_CONFIRMATION_PHRASE),
})

export type RequestAccountDeletion = z.infer<typeof RequestAccountDeletionSchema>

/**
 * 本 domain 的错误码。其余复用 system 的 `VALIDATION_FAILED`（422）、
 * auth 的 `UNAUTHENTICATED`（401）与 governance 的 `USER_RESTRICTED`（403）。
 *
 * 失败原因与对方写在 `message` 里（信封没有结构化字段放它，而 `details` 是字段级校验错误）：
 * 未完成交易回报「有几笔、对方是谁」，BAN 回报「账号被封禁」。
 */
export const AccountDeletionErrorCodeSchema = z.enum([
  /**
   * 409：存在未完成交易（`transactions.status = 'PENDING_MEETUP'`，买家或卖家任一侧），
   * 或（#465 合入后）存在进行中的争议。`message` 回报具体笔数与对方昵称。
   */
  'ACCOUNT_DELETION_BLOCKED_PENDING_TRANSACTION',
  /**
   * 403：`user_restrictions` 中存在生效中的 `BAN`。
   *
   * 封禁中的账号不能通过注销把自己抹掉（否则「封禁」可以一键失效）。先申诉解除封禁，
   * 再申请注销。
   */
  'ACCOUNT_DELETION_BLOCKED_BANNED',
  /**
   * 403：冷静期内调用了被禁止的写入口。
   *
   * 由 `requireAuth` 单点拦截抛出（不是各业务模块自己判）：除 GET/HEAD 与白名单
   * （登出、登录、本域三条方法）外的一切写请求都回它。端上据此提示「注销申请处理中，
   * 暂不能发布 / 留言 / 聊天 / 交易，可撤回申请」。
   */
  'ACCOUNT_DELETION_PENDING',
])

export type AccountDeletionErrorCode = z.infer<typeof AccountDeletionErrorCodeSchema>
