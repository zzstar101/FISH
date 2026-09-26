import { AuthStatusSchema, MeSchema } from '@fish/contracts/auth/user'
import {
  ListingCategorySchema,
  ListingConditionSchema,
  ListingStatusSchema,
} from '@fish/contracts/listings/schema'
import { ModerationDecisionSchema, ModerationStatusSchema } from '@fish/contracts/moderation/schema'
import { transactionStatusSchema } from '@fish/contracts/transactions/schema'
import { z } from 'zod'
import {
  AuditLogIdSchema,
  ListingIdSchema,
  ModerationRecordIdSchema,
  ReportIdSchema,
  TransactionIdSchema,
  UserIdSchema,
  UserRestrictionIdSchema,
} from '../system/public-id'

/**
 * Admin Domain Contract（Issue #73）。
 *
 * 本目录是管理后台的唯一协议来源：API 与 Web 管理员页面都从这里 import，禁止在别处重复定义
 * 枚举或值域。设计见 `docs/design/issue-73-admin.md`。
 *
 * 边界（设计 §3.2 / §8）：
 * - 普通用户的 `Me` DTO **不**暴露 `role`；只有 `/admin/me` 会返回带 `role` 的管理员资料。
 * - 所有列表统一游标分页（`{ items, nextCursor }`），`limit` 服务端封顶 50。
 * - 审计日志的 `before` / `after` 只允许存**脱敏快照**；禁止密码 / Cookie / 完整学号。
 *
 * Moderation DTO 复用 `@fish/contracts/moderation` 的结果值域；审核规则与敏感词内容仍由
 * Moderation Domain 负责，Admin 只消费脱敏结果并承载人工决定。
 */

// ---------------------------------------------------------------------------
// 角色
// ---------------------------------------------------------------------------

/** 用户角色。镜像 DB 枚举 `user_role`（packages/db/src/schema/users.ts），大小写不得漂移。 */
export const UserRoleSchema = z.enum(['USER', 'ADMIN'])
export type UserRole = z.infer<typeof UserRoleSchema>

/**
 * 脱敏学号：保留首尾、中段以 `*` 掩蔽（12 位学号 → `2021****0001`）。
 *
 * 两条规则：
 * - 8 位及以下只留首位各 1 位，中间全部掩蔽（过短则整体掩蔽）；
 * - 9 位及以上按长度收缩保留位数，保证首尾各不超过 4 位且掩蔽位数不少于 4（12 位仍是首 4 + 尾 4）。
 */
export function maskStudentNo(studentNo: string): string {
  if (studentNo.length <= 8) {
    // 短学号退化为「首 + 掩蔽 + 尾」；过短（≤2）无法保留首尾则整体掩蔽。
    if (studentNo.length <= 2) return '*'.repeat(studentNo.length)
    return `${studentNo[0]}${'*'.repeat(studentNo.length - 2)}${studentNo.at(-1)}`
  }
  // 9 位以上：固定「首 4 + 尾 4」在 9–11 位上会露出 8 位（9 位学号几乎等于没脱敏，
  // 输出还比原串长），所以按长度收缩保留位数；12 位仍得到 keep = 4。
  const keep = Math.min(4, Math.floor((studentNo.length - 4) / 2))
  return `${studentNo.slice(0, keep)}${'*'.repeat(studentNo.length - keep * 2)}${studentNo.slice(-keep)}`
}

// ---------------------------------------------------------------------------
// 当前管理员
// ---------------------------------------------------------------------------

/**
 * 管理后台可用能力。**只列已实现的能力**：#74 落地人工审核写入后再把
 * `MODERATION_WRITE` 加进这里，避免前端读到它不存在的权限。
 */
export const AdminCapabilitySchema = z.enum([
  'USERS_READ',
  'LISTINGS_READ',
  'OVERVIEW_READ',
  'AUDIT_LOGS_READ',
  'MODERATION_READ',
  'MODERATION_WRITE',
  'TRANSACTIONS_READ',
])
export type AdminCapability = z.infer<typeof AdminCapabilitySchema>

/** `/admin/me` 的管理员资料：复用认证域 `Me`，只补 `role`（敏感字段仍不返回）。 */
export const AdminMeSchema = MeSchema.extend({ role: UserRoleSchema })
export type AdminMe = z.infer<typeof AdminMeSchema>

export const AdminMeResponseSchema = z
  .object({
    admin: AdminMeSchema,
    capabilities: z.array(AdminCapabilitySchema),
  })
  // 契约自证：/admin/me 只对 ADMIN 提供服务（普通用户由 requireAdmin 拦在 403，到不了这里）。
  .refine((value) => value.admin.role === 'ADMIN', {
    path: ['admin', 'role'],
    message: '/admin/me 只对 ADMIN 提供服务',
  })
export type AdminMeResponse = z.infer<typeof AdminMeResponseSchema>

// ---------------------------------------------------------------------------
// 用户查询
// ---------------------------------------------------------------------------

/** 管理员视角的用户摘要（设计 §4.2）。不返回密码哈希、完整学号等敏感凭据。 */
export const AdminUserSummarySchema = z.object({
  id: UserIdSchema,
  /**
   * 脱敏学号（`2021****0001`），完整学号不进协议。
   * #86 后微信注册的用户没有学号 → `null`（不是空串；端上据此显示占位而不是 "n**l"）。
   */
  studentNoMasked: z.string().min(1).nullable(),
  nickname: z.string(),
  authStatus: AuthStatusSchema,
  role: UserRoleSchema,
  createdAt: z.iso.datetime(),
  /** 在售+非在售的发布商品总数（含 OFFLINE / RESERVED / SOLD）。 */
  listingCount: z.number().int().nonnegative(),
  /** 最近一次登录会话时间（sessions.created_at）；从未登录为 `null`。 */
  lastActivityAt: z.iso.datetime().nullable(),
})
export type AdminUserSummary = z.infer<typeof AdminUserSummarySchema>

export const AdminUserSummaryPageSchema = z.object({
  items: z.array(AdminUserSummarySchema),
  /** 不透明游标：前端严禁解析或构造，只能原样回传上一页的值。 */
  nextCursor: z.string().nullable(),
})
export type AdminUserSummaryPage = z.infer<typeof AdminUserSummaryPageSchema>

/** 商品状态分桶（用户详情的商品统计）。值集与 #6 的 `ListingStatusSchema` 一致。 */
export const AdminListingStatusCountSchema = z.object({
  ACTIVE: z.number().int().nonnegative(),
  RESERVED: z.number().int().nonnegative(),
  SOLD: z.number().int().nonnegative(),
  OFFLINE: z.number().int().nonnegative(),
})
export type AdminListingStatusCount = z.infer<typeof AdminListingStatusCountSchema>

export const AdminAuditTargetTypeSchema = z.enum([
  'USER',
  'LISTING',
  'MODERATION_RECORD',
  'REPORT',
  'USER_RESTRICTION',
])
export type AdminAuditTargetType = z.infer<typeof AdminAuditTargetTypeSchema>

export const AdminAuditTargetIdSchema = z.union([
  UserIdSchema,
  ListingIdSchema,
  ModerationRecordIdSchema,
  ReportIdSchema,
  UserRestrictionIdSchema,
])

const auditTargetIdByType = {
  USER: UserIdSchema,
  LISTING: ListingIdSchema,
  MODERATION_RECORD: ModerationRecordIdSchema,
  REPORT: ReportIdSchema,
  USER_RESTRICTION: UserRestrictionIdSchema,
} satisfies Record<AdminAuditTargetType, (typeof AdminAuditTargetIdSchema.options)[number]>

function auditTargetMatches(value: {
  targetType?: AdminAuditTargetType
  targetId?: z.infer<typeof AdminAuditTargetIdSchema> | null
}): boolean {
  return (
    value.targetId == null ||
    value.targetType === undefined ||
    auditTargetIdByType[value.targetType].safeParse(value.targetId).success
  )
}

export const AdminUserDetailSchema = z.object({
  user: AdminUserSummarySchema,
  listingStats: AdminListingStatusCountSchema,
  /**
   * 该用户当前**生效中**的限制（#73 PR3，评审 m6）。
   *
   * Admin 需要它才能让治理按钮反映真实状态：没有这个字段时前端只能把三个按钮
   * （限制发布 / 封禁 / 解除限制）恒定全显，于是「没有任何生效限制的用户」也会看到一个
   * 点了必然 409 的解除按钮，无从判断该用户当前到底受什么限制。
   *
   * 只列生效中的（不含已过期 / 已解除）——历史限制都在 `recentAuditLogs` 里。
   */
  activeRestrictions: z.array(
    z.object({
      id: UserRestrictionIdSchema,
      type: z.string(),
      reason: z.string(),
      expiresAt: z.iso.datetime().nullable(),
      createdAt: z.iso.datetime(),
    }),
  ),
  /** 最近 10 条针对该用户的 Admin 操作（时间倒序；空数组 = 无操作记录）。 */
  recentAuditLogs: z.array(
    z
      .object({
        id: AuditLogIdSchema,
        action: z.string(),
        targetType: AdminAuditTargetTypeSchema,
        targetId: AdminAuditTargetIdSchema.nullable(),
        reason: z.string().nullable(),
        createdAt: z.iso.datetime(),
      })
      .refine(auditTargetMatches, { path: ['targetId'], message: '审计目标 ID 与资源类型不匹配' }),
  ),
})
export type AdminUserDetail = z.infer<typeof AdminUserDetailSchema>

// ---------------------------------------------------------------------------
// 商品查询
// ---------------------------------------------------------------------------

export const AdminSellerSummarySchema = z.object({
  id: UserIdSchema,
  nickname: z.string(),
})
export type AdminSellerSummary = z.infer<typeof AdminSellerSummarySchema>

export const AdminListingSummarySchema = z.object({
  id: ListingIdSchema,
  title: z.string(),
  priceCents: z.number().int().nonnegative(),
  // 直接复用商品域枚举：这三个字段的数据来源就是 `listings` 表的同名列，
  // 写成 `z.string()` 会让 Web 拿到 `string`（被迫 `as never`），契约也挡不住非法值。
  category: ListingCategorySchema,
  condition: ListingConditionSchema,
  status: ListingStatusSchema,
  createdAt: z.iso.datetime(),
  /** 无图商品为 `null`（与 #6 `ListingCardSchema.coverUrl` 同口径）。 */
  coverUrl: z.url().nullable(),
  seller: AdminSellerSummarySchema,
})
export type AdminListingSummary = z.infer<typeof AdminListingSummarySchema>

export const AdminListingSummaryPageSchema = z.object({
  items: z.array(AdminListingSummarySchema),
  nextCursor: z.string().nullable(),
})
export type AdminListingSummaryPage = z.infer<typeof AdminListingSummaryPageSchema>

export const AdminListingDetailSchema = z.object({
  id: ListingIdSchema,
  title: z.string(),
  description: z.string(),
  priceCents: z.number().int().nonnegative(),
  category: ListingCategorySchema,
  condition: ListingConditionSchema,
  status: ListingStatusSchema,
  /**
   * 审核引擎视角的状态（#73 PR3，评审 M3）。
   *
   * 与 `status` 分开：治理下架会同时写 `status='OFFLINE'` 与 `moderationStatus='BLOCKED'`，
   * 而审核引擎屏蔽商品时只写后者（`status` 保持卖家放的状态）。Admin 要靠它区分
   * 「这条该走 restore 还是走人工审核」。
   */
  moderationStatus: z.enum(['APPROVED', 'REVIEW', 'BLOCKED']),
  /**
   * 治理下架时刻；`null` = 没有被治理下架过（评审 M3）。
   *
   * 恢复上架按钮只在这一列非空时可用——否则会把审核引擎屏蔽的商品放回公开列表，
   * 等于用治理端点绕过审核。
   */
  governanceDelistedAt: z.iso.datetime().nullable(),
  urgent: z.boolean(),
  negotiable: z.boolean(),
  free: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  images: z.array(z.object({ url: z.url(), sortOrder: z.number().int().nonnegative() })),
  seller: AdminSellerSummarySchema,
  /** 最近 10 条针对该商品的 Admin 操作（时间倒序；空数组 = 无操作记录）。 */
  recentAuditLogs: z.array(
    z.object({
      id: AuditLogIdSchema,
      action: z.string(),
      targetType: AdminAuditTargetTypeSchema,
      reason: z.string().nullable(),
      createdAt: z.iso.datetime(),
    }),
  ),
})
export type AdminListingDetail = z.infer<typeof AdminListingDetailSchema>

// ---------------------------------------------------------------------------
// 平台概览
// ---------------------------------------------------------------------------

/**
 * 固定口径的聚合指标（设计 §4.5）。**只提供预定义指标，不接受任意 SQL / 任意聚合表达式**。
 *
 * #74 Moderation 落地前不在此返回「待人工审核数 / 近 7 日审核通过·拦截数」——那两个口径依赖
 * #74 的表，先硬编码 0 或假装有值都是错的；#74 冻结后在此增量补充。
 */
export const AdminOverviewSchema = z.object({
  totalUsers: z.number().int().nonnegative(),
  newUsersLast24h: z.number().int().nonnegative(),
  /** listings.status = ACTIVE 的在售商品数。 */
  activeListings: z.number().int().nonnegative(),
  /** transactions.status = COMPLETED 的完成交易数。 */
  completedTransactions: z.number().int().nonnegative(),
  /**
   * 待人工审核数：`listings.moderation_status = 'REVIEW'` 的商品数（#73 治理半场 PR4）。
   * 与审核队列条目不是同一个口径——队列按「每条 listing 只显示最新 REVIEW 记录」去重，
   * 这里数的是商品，用于概览卡片刻意不重申。
   */
  pendingReviewRecords: z.number().int().nonnegative(),
  /** 待处理举报数：`reports.status = 'PENDING'` 的全量 count，不是当前页条数。 */
  pendingReports: z.number().int().nonnegative(),
  /** 近 7 日新增举报数（含已处理），`reports.created_at >= now() - 7 days`。 */
  reportsLast7d: z.number().int().nonnegative(),
  /**
   * 生效中的限制数：`user_restrictions` 的全量 count，谓词是
   * `status = 'ACTIVE' AND (expires_at IS NULL OR expires_at > now())`。
   *
   * `expires_at` 是惰性判断（没有定时任务，到期行在表里仍是 ACTIVE），所以必须和读时
   * 同一个谓词。写成裸 `status='ACTIVE'` 会把已过期但仍标 ACTIVE 的行算进来，Overview
   * 虚高，且与写入口的放行行为不一致。
   */
  activeRestrictions: z.number().int().nonnegative(),
})
export type AdminOverview = z.infer<typeof AdminOverviewSchema>

// ---------------------------------------------------------------------------
// 审计日志
// ---------------------------------------------------------------------------

/** Admin 动作枚举。高风险人工审核决定必须写入不可变审计日志。 */
export const AdminAuditActionSchema = z.enum([
  'ADMIN_PROMOTED',
  'MODERATION_DECISION',
  // #73 治理半场 PR2：处理举报（只写结果，不动商品或用户）。
  'REPORT_DECISION',
  // #73 治理半场 PR3：五个治理端点各一个 action，审计可按动作单独筛选。
  'LISTING_DELISTED',
  'LISTING_RESTORED',
  'USER_RESTRICTED',
  'USER_RESTRICTION_LIFTED',
  'USER_BANNED',
  'USER_UNBANNED',
])
export type AdminAuditAction = z.infer<typeof AdminAuditActionSchema>

export const AdminAuditLogEntrySchema = z
  .object({
    id: AuditLogIdSchema,
    /** 操作者；用户被删或初始化提升（无既有 actor）时为 `null`。 */
    actor: z
      .object({
        id: UserIdSchema,
        nickname: z.string(),
      })
      .nullable(),
    action: AdminAuditActionSchema,
    targetType: AdminAuditTargetTypeSchema,
    targetId: AdminAuditTargetIdSchema.nullable(),
    /** 脱敏快照（不存密码 / Cookie / 完整学号）。 */
    before: z.record(z.string(), z.unknown()).nullable(),
    after: z.record(z.string(), z.unknown()).nullable(),
    reason: z.string().nullable(),
    requestId: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .refine(auditTargetMatches, { path: ['targetId'], message: '审计目标 ID 与资源类型不匹配' })
export type AdminAuditLogEntry = z.infer<typeof AdminAuditLogEntrySchema>

export const AdminAuditLogPageSchema = z.object({
  items: z.array(AdminAuditLogEntrySchema),
  nextCursor: z.string().nullable(),
})
export type AdminAuditLogPage = z.infer<typeof AdminAuditLogPageSchema>

// ---------------------------------------------------------------------------
// Moderation / transaction 查询
// ---------------------------------------------------------------------------

export const AdminModerationRecordSchema = z.object({
  id: ModerationRecordIdSchema,
  listingId: ListingIdSchema.nullable(),
  sellerId: UserIdSchema,
  action: z.string().min(1),
  titleSnapshot: z.string(),
  descriptionSnapshot: z.string(),
  decision: ModerationDecisionSchema,
  matchedRules: z.array(z.string()),
  matchedTermsMasked: z.array(z.string()),
  ruleVersion: z.string().min(1),
  createdAt: z.iso.datetime(),
})
export type AdminModerationRecord = z.infer<typeof AdminModerationRecordSchema>

export const AdminModerationQueueItemSchema = z.object({
  record: AdminModerationRecordSchema,
  listing: z.object({
    id: ListingIdSchema,
    title: z.string(),
    description: z.string(),
    status: ListingStatusSchema,
    moderationStatus: ModerationStatusSchema,
    moderationReason: z.string().nullable(),
    createdAt: z.iso.datetime(),
  }),
  seller: z.object({ id: UserIdSchema, nickname: z.string() }),
})
export type AdminModerationQueueItem = z.infer<typeof AdminModerationQueueItemSchema>

export const AdminModerationQueueSchema = z.object({
  items: z.array(AdminModerationQueueItemSchema),
  nextCursor: z.string().nullable(),
})
export type AdminModerationQueue = z.infer<typeof AdminModerationQueueSchema>

export const AdminModerationDetailSchema = z.object({
  item: AdminModerationQueueItemSchema,
  history: z.array(AdminModerationRecordSchema),
  machineDecision: ModerationDecisionSchema.nullable(),
  humanDecision: z
    .object({
      decision: z.enum(['ALLOW', 'BLOCK']),
      reason: z.string(),
      actor: z.object({ id: UserIdSchema, nickname: z.string() }).nullable(),
      decidedAt: z.iso.datetime(),
    })
    .nullable(),
})
export type AdminModerationDetail = z.infer<typeof AdminModerationDetailSchema>

/**
 * 审核记录检索（#73 治理半场 PR4）：与 `AdminModerationQueueSchema` 同一条目形状，
 * 但**不带**「只留每条 listing 最新 REVIEW 记录」和「只列待审商品」这两个收窄——
 * 队列是工作清单，这里是已经离开队列的历史（含 ALLOW / BLOCK / 仍 REVIEW 的）。
 */
export const AdminModerationRecordsSchema = z.object({
  /** 记录可比商品存活更久；物理删除商品后仍展示审核快照。 */
  items: z.array(
    AdminModerationQueueItemSchema.extend({
      listing: AdminModerationQueueItemSchema.shape.listing.nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
})
export type AdminModerationRecords = z.infer<typeof AdminModerationRecordsSchema>

export const AdminTransactionSchema = z.object({
  id: TransactionIdSchema,
  listingId: ListingIdSchema,
  listingTitle: z.string(),
  buyer: z.object({ id: UserIdSchema, nickname: z.string() }),
  seller: z.object({ id: UserIdSchema, nickname: z.string() }),
  amountCents: z.number().int().nonnegative(),
  status: transactionStatusSchema,
  buyerConfirmedAt: z.iso.datetime().nullable(),
  sellerConfirmedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type AdminTransaction = z.infer<typeof AdminTransactionSchema>

export const AdminTransactionPageSchema = z.object({
  items: z.array(AdminTransactionSchema),
  nextCursor: z.string().nullable(),
})
export type AdminTransactionPage = z.infer<typeof AdminTransactionPageSchema>

// ---------------------------------------------------------------------------
// 错误码
// ---------------------------------------------------------------------------

export const AdminErrorCodeSchema = z.enum([
  /**
   * 403：已登录但角色不是 ADMIN，或角色查询失败。**稳定判据**（设计 §3.2）：
   * 普通用户访问任何 `/admin/*` 都返回它，不能靠修改前端状态绕过。
   */
  'FORBIDDEN',
  /** 404：管理查询的目标（用户 / 商品）不存在。管理后台内部工具，不做存在性隐藏。 */
  'ADMIN_NOT_FOUND',
  /** 409：审核记录已被其它管理员处理，避免覆盖最终决定。 */
  'MODERATION_CONFLICT',
])
export type AdminErrorCode = z.infer<typeof AdminErrorCodeSchema>

// ---------------------------------------------------------------------------
// 查询参数（设计 §4）。`limit` 默认 20、服务端封顶 50；越界 → 422。
// 游标对前端不透明，只校验形态（`min(1)`），内容校验在服务端 `decodeCursor`。
// 预留给 #74 的 `reviewStatus` 等筛选不再此定义（第 4.3 节待 #74 Contract 冻结）。
// ---------------------------------------------------------------------------

export const AdminUsersQuerySchema = z.strictObject({
  /** 学号精确匹配或昵称前缀搜索。 */
  q: z.string().trim().min(1).max(50).optional(),
  authStatus: AuthStatusSchema.optional(),
  role: UserRoleSchema.optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

export const AdminListingsQuerySchema = z.strictObject({
  /** title / description 子串搜索。 */
  q: z.string().trim().min(1).max(50).optional(),
  status: ListingStatusSchema.optional(),
  sellerId: UserIdSchema.optional(),
  /**
   * 时间段（**左闭右开**：`>= createdFrom` 且 `< createdTo`，与 `store.ts` 的条件一致）；
   * ISO datetime。取「含边界」的客户端会丢掉恰好等于 `createdTo` 的那条记录。
   */
  createdFrom: z.iso.datetime().optional(),
  createdTo: z.iso.datetime().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

export const AdminAuditLogsQuerySchema = z
  .strictObject({
    actorId: UserIdSchema.optional(),
    action: AdminAuditActionSchema.optional(),
    targetType: AdminAuditTargetTypeSchema.optional(),
    targetId: AdminAuditTargetIdSchema.optional(),
    /** 同 `AdminListingsQuerySchema`：左闭右开。 */
    createdFrom: z.iso.datetime().optional(),
    createdTo: z.iso.datetime().optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .refine(auditTargetMatches, { path: ['targetId'], message: '审计目标 ID 与资源类型不匹配' })

export const AdminModerationQueueQuerySchema = z.strictObject({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

/**
 * 审核记录检索参数（#73 治理半场 PR4）。与 `AdminModerationQueueQuerySchema` 的区别只有
 * 筛选维度——分页口径（`limit` 默认 20 封顶 50、cursor 形态）完全一致。
 */
export const AdminModerationRecordsQuerySchema = z.strictObject({
  /** 机器 / 人工判定。`REVIEW` 会同时列出机器判 REVIEW 与已被人工决定的记录。 */
  decision: ModerationDecisionSchema.optional(),
  listingId: ListingIdSchema.optional(),
  /**
   * 商品关键词搜索（ILIKE，`%_\` 转义）。检索的是 listings 表的**当前** title /
   * description，不是记录上的快照——快照是当时内容，按现标题找不到对应行。同
   * `AdminListingsQuerySchema.q` 的口径，行为一致。
   */
  q: z.string().trim().min(1).max(50).optional(),
  /** 同 `AdminListingsQuerySchema`：左闭右开。 */
  createdFrom: z.iso.datetime().optional(),
  createdTo: z.iso.datetime().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

export const AdminTransactionQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(50).optional(),
  status: transactionStatusSchema.optional(),
  buyerId: UserIdSchema.optional(),
  sellerId: UserIdSchema.optional(),
  listingId: ListingIdSchema.optional(),
  createdFrom: z.iso.datetime().optional(),
  createdTo: z.iso.datetime().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})
