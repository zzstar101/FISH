import { NicknameSchema } from '@fish/contracts/auth/session'
import { MeSchema } from '@fish/contracts/auth/user'
import { ListingCardSchema } from '@fish/contracts/listings/schema'
import {
  type TransactionListing,
  type TransactionStatus,
  type TransactionUser,
  transactionListingSchema,
  transactionRoleSchema,
  transactionStatusSchema,
  transactionUserSchema,
} from '@fish/contracts/transactions/schema'
import { wishDtoSchema } from '@fish/contracts/wishes/schema'
import { z } from 'zod'
import { ListingIdSchema, TransactionIdSchema } from '../system/public-id'

/**
 * Profile Domain Contract（Issue #12）。前端和 API 只依赖本目录的字段定义。
 *
 * 复用而非重写：user 块是认证域的 `Me`（requireAuth 已写入 context，avatarUrl 的脏值
 * 回退逻辑不复制第二份）；商品卡是 #6 的 `ListingCardSchema`（本人视角可见全部状态）；
 * 愿望是 #7 的 `wishDtoSchema`；交易摘要的 status / role / listing / counterpart
 * 四个组件**直接复用 #11 的官方契约**，不再本地投影（#11 已合入 main，#12 的注释
 * 曾承诺「合并后迁移」）。
 *
 * 为什么不是对 `transactionDtoSchema` 做 `.pick()` / `.omit()`：官方 DTO 末尾链了
 * 两条 `.refine()`（status ↔ completedAt / cancelledAt 的联合完整性），已经不是
 * `ZodObject`，取不到 `.pick()`；所以这里复用它的**组件 schema**。本域投影刻意不带
 * buyerId / sellerId 与各确认时间戳——订单卡和「我买 / 我卖」分组只需要 role 与 counterpart。
 */

/** 别名指向官方枚举：值集改动时两侧一起变，不再有两份事实源。 */
export const profileTransactionStatusSchema = transactionStatusSchema
export type ProfileTransactionStatus = TransactionStatus

export const profileTransactionListingSchema = transactionListingSchema
export type ProfileTransactionListing = TransactionListing

export const profileTransactionUserSchema = transactionUserSchema
export type ProfileTransactionUser = TransactionUser

export const profileTransactionSchema = z.object({
  id: TransactionIdSchema,
  listingId: ListingIdSchema,
  /** 查看者在交易中的角色（买入 / 卖出列表合并返回，前端据此分组）。 */
  role: transactionRoleSchema,
  /** 订单卡渲染用（服务端组装，前端不逐行回查）；amountCents 是议价结果，与挂价独立。 */
  listing: profileTransactionListingSchema,
  /** 交易对方（查看者视角解析）。 */
  counterpart: profileTransactionUserSchema,
  amountCents: z.number().int().nonnegative(),
  status: profileTransactionStatusSchema,
  createdAt: z.iso.datetime(),
})
export type ProfileTransaction = z.infer<typeof profileTransactionSchema>

export const profileStatsSchema = z.object({
  /** 在售商品数（listings.status = ACTIVE 且 seller 是我）。 */
  activeListings: z.number().int().nonnegative(),
  /** 活跃愿望数（wishes.status = 'ACTIVE' 且 user 是我；预算为 NULL 的同样计入，与列表同口径）。 */
  activeWishes: z.number().int().nonnegative(),
  /** 完成交易数（买卖两个角色合并计）。 */
  completedTransactions: z.number().int().nonnegative(),
  /**
   * 我关注的人数（`follows.follower_id = 我`，#188）。
   *
   * 与「我的关注」列表同源（同一张表、同一个方向）：数字栏写「关注 N」而点进去是另一个
   * 数就是错的。这里只放**关注**方向——粉丝数与互粉数没有对应的数字栏，接口出现前不加字段。
   */
  followingCount: z.number().int().nonnegative(),
  // 「买入 / 卖出条数」刻意不设计数：由前端对 transactions[] 按 role 分组得到。
  // 该列表封顶 100（见 profileResponseSchema 注释），计数在封顶内准确——超出属于
  // demo 数据量之外的规模，届时应扩独立分页端点而不是在 stats 里加 COUNT。
})
export type ProfileStats = z.infer<typeof profileStatsSchema>

/**
 * 待人工复审的资料变更（#694 M5）。
 *
 * 昵称 / 签名 / 头像在写入公开列**之前**要过公开 UGC 审核：机审 `REVIEW` 时新值不落
 * `users`（旧公开值继续对外可见、所有投射口径不变），只在这条待审记录里留给本人与管理员看。
 * 管理员放行后才一次性切换公开值。
 *
 * `fields` 列出本次提交涉及的字段，用来区分「没提交签名」与「提交了清空签名」——
 * 后者 `signature` 同样是 `null`，只看值分不出来。
 *
 * **只有本人和管理员**能读到它：`GET /profile` 是本人视角；管理端另有待审队列端点。
 */
export const profilePendingChangeSchema = z.object({
  nickname: z.string().nullable(),
  signature: z.string().nullable(),
  avatarUrl: z.url().nullable(),
  fields: z.array(z.enum(['nickname', 'signature', 'avatarUrl'])),
  /** 提交时刻（服务端时钟）。 */
  submittedAt: z.iso.datetime(),
})
export type ProfilePendingChange = z.infer<typeof profilePendingChangeSchema>

/**
 * 资料写入的错误码（`PATCH /profile`）。
 *
 * - `PROFILE_CONTENT_BLOCKED`（422）：昵称 / 签名被公开 UGC 策略判为阻断，**任何公开值都没变**，
 *   用户改文案后可重试；
 * - `CONTENT_MODERATION_UNAVAILABLE`（503）：审核服务不可用（超时 / 网络 / 上游错误），
 *   按 fail-closed 处理：本次提交不落库，可稍后重试。**不会降级为「先放行」**；
 * - `IMAGE_CONTENT_BLOCKED` / `IMAGE_REFERENCE_INVALID` / `UPLOAD_OBJECT_MISSING`（422）：
 *   沿用上传域的头像错误码（见 `ListingErrorCodeSchema`）；
 * - `VALIDATION_FAILED`（422）：请求体本身不合法，带字段级 `details`。
 */
export const PROFILE_ERROR_CODES = [
  'PROFILE_CONTENT_BLOCKED',
  'CONTENT_MODERATION_UNAVAILABLE',
  'IMAGE_CONTENT_BLOCKED',
  'IMAGE_REFERENCE_INVALID',
  'UPLOAD_OBJECT_MISSING',
  'VALIDATION_FAILED',
] as const
export type ProfileErrorCode = (typeof PROFILE_ERROR_CODES)[number]

export const profileResponseSchema = z.object({
  /** 认证域的 Me（requireAuth 产出）：头像、昵称、认证状态都在这里。 */
  user: MeSchema,
  stats: profileStatsSchema,
  /**
   * 我发布的商品（本人视角，含 OFFLINE / RESERVED / SOLD；时间倒序）。
   * P0 不分页：各列表服务端封顶 100 条（demo 数据量内足够），超出再扩游标端点。
   */
  listings: z.array(ListingCardSchema),
  /** 我的愿望（全部状态；时间倒序，含 matchCount）。 */
  wishes: z.array(wishDtoSchema),
  /** 我的买入 / 卖出交易（合并返回，按 role 分组；时间倒序）。 */
  transactions: z.array(profileTransactionSchema),
  /**
   * 待人工复审的资料变更（#694 M5）：没有待审变更时为 `null`。
   * 只有本人能读到——待审新值不进任何公开投射（列表 / 商品卡 / 聊天 sender / 评价作者）。
   *
   * `.default(null)` 让「老端 / 老 API 不含该字段」仍可解析：小程序端与本接口独立发版，
   * 缺字段时退化成「没有待审」，不要因为多了一个字段就把整份资料读不出来。
   */
  pending: profilePendingChangeSchema.nullable().default(null),
})
export type ProfileResponse = z.infer<typeof profileResponseSchema>

/**
 * #86 B 节：编辑资料（昵称 / 头像）的写契约，对应 `PATCH /profile`。
 *
 * 两个字段都可选，但**至少要给一项**：空对象没有语义，接受它只会让端上把「什么都没改」
 * 记成一次成功写入（也会让服务端白跑一次 UPDATE）。
 *
 * 头像刻意收 **objectKey** 而不是 URL —— URL 由服务端用与 `POST /uploads/confirm`
 * 完全相同的校验（归属前缀 + 对象确实已上传 + 格式/大小合规）拼出来，端上无法把
 * 任意外链写进 `users.avatar_url`。
 *
 * 昵称复用认证域的 `NicknameSchema`（trim + 1–20 字），注册与改名不会出现两套长度口径。
 */
/**
 * 个性签名（#179）。长度上限冻结在 200 字符（trim 后计），契约不落 DB CHECK，
 * 超长在这里 422。语义：
 * - **允许换行**：服务端存原文（trim 后），展示层自行取首行（miniapp `signatureFirstLine`）；
 * - **空串 = 清空**：trim 后为空的输入由服务端归一化落 `null`，与「从未填写」同态；
 * - 不设最短长度：只留空白等于想清空，不该被 422 挡住。
 */
export const SignatureSchema = z.string().trim().max(200, '个性签名最多 200 字')

export const profileUpdateRequestSchema = z
  .strictObject({
    nickname: NicknameSchema.optional(),
    /** `POST /uploads/confirm` 返回的 objectKey（`listings/{userId}/{uuid}.{ext}`）。 */
    avatarObjectKey: z.string().trim().min(1).max(256).optional(),
    /** 个性签名（#179）；缺省 = 不修改。空串 = 清空。 */
    signature: SignatureSchema.optional(),
  })
  .refine(
    (value) =>
      value.nickname !== undefined ||
      value.avatarObjectKey !== undefined ||
      value.signature !== undefined,
    {
      message: 'nickname 与 avatarObjectKey 与 signature 至少要提供一项',
    },
  )

export type ProfileUpdateRequest = z.infer<typeof profileUpdateRequestSchema>

/**
 * 写接口只回更新后的 `Me`，不回整个聚合视图：端上拿到就覆盖全局 store
 * （头像 / 昵称在「我的」页与商品卡卖家位都要立刻变），页面不必再补一次 `GET /profile`。
 *
 * `pending` 是每次写之后的待审状态（#694 M5）：机审判 `REVIEW` 时 `user` 仍是**旧公开值**，
 * 新值只在 `pending` 里；端上据此提示「审核中」，而不是把未生效的值当成已保存。
 */
export const profileUpdateResponseSchema = z.object({
  user: MeSchema,
  /** 同上：老 API 不回 `pending` 时按「没有待审」解析，端上不会因此写失败。 */
  pending: profilePendingChangeSchema.nullable().default(null),
})

export type ProfileUpdateResponse = z.infer<typeof profileUpdateResponseSchema>
