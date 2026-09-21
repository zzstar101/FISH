import { z } from 'zod'
import { ListingStatusSchema, PriceCentsSchema } from '../listings/schema'

/** Transaction Domain Contract（Issue #11）。前端和 API 只依赖本目录的字段定义。 */

/**
 * DB 无 REQUESTED 态：交易行**只在卖家接受时创建**（PENDING_MEETUP = 已接受、待面交）；
 * 买家「发起确认」与卖家「拒绝」不落 transactions 表，由会话里的 SYSTEM 消息承载
 * （packages/db/src/schema/transactions.ts 的表注释同源）。
 */
export const transactionStatusSchema = z.enum(['PENDING_MEETUP', 'COMPLETED', 'CANCELLED'])
export type TransactionStatus = z.infer<typeof transactionStatusSchema>

/** 查看者在交易中的角色，同一交易对买卖双方输出不同值。
 * 刻意不 import chat 的 conversationRoleSchema：交易域不依赖聊天域，
 * 值集漂移由两侧的契约测试各自冻结（chat 侧同款枚举见 chat/schema.ts）。 */
export const transactionRoleSchema = z.enum(['buyer', 'seller'])
export type TransactionRole = z.infer<typeof transactionRoleSchema>

/** 订单卡内嵌的商品摘要，服务端组装——前端渲染订单列表不必逐行回查商品详情（N+1）。 */
export const transactionListingSchema = z.object({
  id: z.string(),
  title: z.string(),
  priceCents: z.number().int(),
  status: ListingStatusSchema,
  coverUrl: z.url().nullable(),
})
export type TransactionListing = z.infer<typeof transactionListingSchema>

/** 订单卡内嵌的对方用户摘要，按查看者视角解析：buyer 看到 seller，反之亦然。 */
export const transactionUserSchema = z.object({
  id: z.string(),
  nickname: z.string(),
  avatarUrl: z.url().nullable(),
})
export type TransactionUser = z.infer<typeof transactionUserSchema>

export const transactionDtoSchema = z
  .object({
    id: z.string(),
    /** 该交易对应的唯一会话；买卖双方读取同一交易时值相同。 */
    conversationId: z.string(),
    listingId: z.string(),
    buyerId: z.string(),
    sellerId: z.string(),
    role: transactionRoleSchema,
    /** 订单卡渲染用；amountCents 是议价结果，与挂价 priceCents 各自独立。 */
    listing: transactionListingSchema,
    /** 交易对方的用户摘要（查看者视角）。 */
    counterpart: transactionUserSchema,
    /** 议价结果，不等于 listings.price_cents；0 元送合法（DB CHECK 同源）。 */
    amountCents: z.number().int().nonnegative(),
    status: transactionStatusSchema,
    /** 「双方确认面交」：两侧各点一次，只点一边时交易仍停在 PENDING_MEETUP。 */
    buyerConfirmedAt: z.iso.datetime().nullable(),
    sellerConfirmedAt: z.iso.datetime().nullable(),
    completedAt: z.iso.datetime().nullable(),
    cancelledAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  // 镜像 DB 的两条 status↔timestamp 联合完整性 CHECK（transactions_completed_at /
  // cancelled_at_matches_status）：实现 bug 把违约行发出去时在这里炸掉，
  // 而不是把自相矛盾的 DTO 交给前端（与 chat 契约对 TEXT⟹sender 的收紧同一先例）。
  .refine((t) => (t.status === 'COMPLETED') === (t.completedAt !== null), {
    path: ['completedAt'],
    error: 'COMPLETED 必须（且只有它）带 completedAt',
  })
  .refine((t) => (t.status === 'CANCELLED') === (t.cancelledAt !== null), {
    path: ['cancelledAt'],
    error: 'CANCELLED 必须（且只有它）带 cancelledAt',
  })
export type TransactionDto = z.infer<typeof transactionDtoSchema>

// ---------------------------------------------------------------------------
// SYSTEM 消息内容协议（提案 / 接受 / 拒绝的载体）
// ---------------------------------------------------------------------------
//
// 提案与拒绝不落库，只存在于 messages 表的 SYSTEM 消息里；messages 表没有元数据列，
// 因此结构化信息编码在 content（JSON 字符串）。本模块直写 messages（Issue #11 明确
// 允许，不要求 #9 的 Chat Service 先存在）；chat 侧对解析失败的 SYSTEM 内容按普通
// 文本渲染（优雅降级），因此本协议的演化不破坏聊天。

export const transactionSystemEventSchema = z.discriminatedUnion('type', [
  /** 买家发起交易确认。 */
  z.object({ type: z.literal('tx.proposal'), amountCents: z.number().int().nonnegative() }),
  /** 卖家接受：transactionId 指向此刻创建的交易行，聊天里可跳交易详情。 */
  z.object({
    type: z.literal('tx.accepted'),
    transactionId: z.string(),
    amountCents: z.number().int().nonnegative(),
  }),
  /** 卖家拒绝。 */
  z.object({ type: z.literal('tx.rejected') }),
])
// 刻意只有三元：终态变化（COMPLETED / CANCELLED）不产生 SYSTEM 消息、也没有交易推送
// ——前端以交易详情/列表为终态来源。这是 Freeze 需向前端显式确认的取舍，不是遗漏。
export type TransactionSystemEvent = z.infer<typeof transactionSystemEventSchema>

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

/**
 * 买家发起交易确认（第一步，不建交易行）：往会话写一条 `tx.proposal` SYSTEM 消息。
 * 前端防抖负责提案不重复；服务端只保证「不会产生两笔有效交易」（见 accept）。
 */
export const transactionProposalInputSchema = z.strictObject({
  /** 会话唯一对应 (listing, buyer)，因此 conversationId 即定位到商品与买家。 */
  conversationId: z.uuid(),
  /** 议价结果随提案带上；接受时以卖家重传的值为准（提案不落库，无处可读）。 */
  amountCents: PriceCentsSchema,
})
export type TransactionProposalInput = z.infer<typeof transactionProposalInputSchema>

/**
 * 卖家接受：**唯一会创建交易行的端点**。原子性 =
 * `UPDATE listings SET status='RESERVED' WHERE id = ? AND status='ACTIVE'` 条件更新
 * + transactions 的部分唯一索引（一个 listing 至多一笔 live/成交）兜底。
 * 输给并发买家或商品已非 ACTIVE 都是 409 LISTING_NOT_ACTIVE。
 * 重试恢复口径（刻意不冻结为幂等 200）：响应丢失后重试收到 409 时，交易可能已在
 * 上一次成功创建——以会话内 `tx.accepted` SYSTEM 消息或 GET /transactions 为准，
 * 前端不得把 409 直译成"接受失败"。
 */
export const transactionAcceptInputSchema = z.strictObject({
  conversationId: z.uuid(),
  amountCents: PriceCentsSchema,
})
export type TransactionAcceptInput = z.infer<typeof transactionAcceptInputSchema>

/** 卖家拒绝提案：往会话写一条 `tx.rejected` SYSTEM 消息。 */
export const transactionRejectInputSchema = z.strictObject({
  conversationId: z.uuid(),
})
export type TransactionRejectInput = z.infer<typeof transactionRejectInputSchema>

export const transactionListQuerySchema = z.strictObject({
  /** 缺省 = 买卖两种角色合并。 */
  role: transactionRoleSchema.optional(),
  status: transactionStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /**
   * 不透明游标（`(created_at, id)` 编码），理由同 chat/listings：CANCELLED 与新交易
   * 都会插到列表前部，offset 翻页必然重复/漏项。
   */
  cursor: z.string().min(1).optional(),
})
export type TransactionListQuery = z.infer<typeof transactionListQuerySchema>

/** 不另给 `hasMore` / `total`：与 #6/#9 的冻结结论一致。 */
export const transactionListResponseSchema = z.object({
  items: z.array(transactionDtoSchema),
  nextCursor: z.string().nullable(),
})
export type TransactionListResponse = z.infer<typeof transactionListResponseSchema>

// ---------------------------------------------------------------------------
// 状态机与幂等（router/service 实现的验收口径）
// ---------------------------------------------------------------------------
//
// 提案 ──卖家接受──▶ PENDING_MEETUP ──双方 confirm──▶ COMPLETED（listing → SOLD）
//                        │
//                        └─ 任一方 cancel → CANCELLED（listing RESERVED → ACTIVE）
//
// - confirm 幂等：PENDING_MEETUP 上重复确认返回当前 DTO（200）；第二侧确认触发
//   COMPLETED + listing SOLD；CANCELLED 上 confirm 拒绝（409 TRANSACTION_NOT_IN_PENDING）。
// - cancel：PENDING_MEETUP 上取消 → CANCELLED + listing 恢复；CANCELLED 上重复取消
//   幂等返回当前 DTO（200）；COMPLETED 上取消拒绝（409 TRANSACTION_NOT_IN_PENDING）。
//   因此拒绝 cancel 的状态只有 COMPLETED，拒绝 confirm 的状态只有 CANCELLED。
// - cancel 恢复 listing 是无条件 RESERVED → ACTIVE：#6 禁止在 RESERVED 上手动下架，
//   因此取消那一刻 listing 必仍是 RESERVED，不需要条件更新。
// - SYSTEM 消息由本模块直写（提案 / tx.accepted / 拒绝三条），先落库再随聊天推送。

// ---------------------------------------------------------------------------
// 错误码：本 domain 新增的部分。其余复用 `auth` 的 `UNAUTHENTICATED`（401）
// 与 `system` 的 `VALIDATION_FAILED` / `INTERNAL_ERROR`。
// ---------------------------------------------------------------------------

/**
 * #147：凭证随交易生命周期——PENDING_MEETUP 内长期有效，交易进终态时同事务销毁。
 * 因此状态只有 NONE（无行）/ ISSUED / CONSUMED；EXPIRED 不再是可达路径。
 */
export const meetupTokenStatusSchema = z.enum(['NONE', 'ISSUED', 'CONSUMED'])
export type MeetupTokenStatus = z.infer<typeof meetupTokenStatusSchema>

export const meetupTokenResponseSchema = z.strictObject({
  transactionId: z.uuid(),
  code: z.string().regex(/^\d{6}$/),
  qrPayload: z.string().min(1),
})
export type MeetupTokenResponse = z.infer<typeof meetupTokenResponseSchema>

export const meetupTokenStatusResponseSchema = z.strictObject({
  transactionId: z.uuid(),
  status: meetupTokenStatusSchema,
  consumedAt: z.iso.datetime().nullable(),
  consumedBy: z.uuid().nullable(),
})
export type MeetupTokenStatusResponse = z.infer<typeof meetupTokenStatusResponseSchema>

export const meetupTokenRedeemInputSchema = z.strictObject({
  qrToken: z.string().min(1),
})
export type MeetupTokenRedeemInput = z.infer<typeof meetupTokenRedeemInputSchema>

export const meetupTokenVerifyCodeInputSchema = z.strictObject({
  code: z.string().regex(/^\d{6}$/, '面交码必须是 6 位数字'),
})
export type MeetupTokenVerifyCodeInput = z.infer<typeof meetupTokenVerifyCodeInputSchema>

export const meetupVerificationResponseSchema = z.strictObject({
  transactionId: z.uuid(),
  verified: z.literal(true),
  verifiedBy: z.uuid(),
  verifiedAt: z.iso.datetime(),
  nextAction: z.literal('CONFIRM_DELIVERY'),
})
export type MeetupVerificationResponse = z.infer<typeof meetupVerificationResponseSchema>

export const TransactionErrorCodeSchema = z.enum([
  /** 404：conversationId 不存在，或调用者不是会话双方（不泄漏存在性）。 */
  'CONVERSATION_NOT_FOUND',
  /** 403：提案端点被会话里的卖家（或外人）调用。 */
  'NOT_CONVERSATION_BUYER',
  /** 403：接受/拒绝端点被会话里的买家（或外人）调用。 */
  'NOT_CONVERSATION_SELLER',
  /** 409：提案或接受时商品非 ACTIVE（RESERVED / SOLD / OFFLINE，含并发输给另一买家）。 */
  'LISTING_NOT_ACTIVE',
  /** 404：交易 id 不存在，或调用者不是交易双方（404 而非 403，不泄漏存在性）。 */
  'TRANSACTION_NOT_FOUND',
  /** 409：终态上的非法操作——COMPLETED 上取消、CANCELLED 上确认（一码两用，见状态机注释）。 */
  'TRANSACTION_NOT_IN_PENDING',
  /** 404：交易当前没有可消费的面交凭证。 */
  'MEETUP_TOKEN_NOT_FOUND',
  /** 409：面交凭证已消费（重复核销）。#147：凭证随交易生命周期，过期不再是可达路径。 */
  'MEETUP_TOKEN_CONSUMED',
  /** 422：二维码或 6 位码无效。 */
  'MEETUP_TOKEN_INVALID',
  /** 429：短时间内输入错误次数过多。 */
  'MEETUP_TOKEN_LOCKED',
  /** 403：仅交易另一方可以消费凭证。 */
  'MEETUP_TOKEN_NOT_ALLOWED',
])
export type TransactionErrorCode = z.infer<typeof TransactionErrorCodeSchema>
