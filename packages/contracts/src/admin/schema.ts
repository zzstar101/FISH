import { AuthStatusSchema, CampusSchema, MeSchema } from '@fish/contracts/auth/user'
import {
  ListingCategorySchema,
  ListingConditionSchema,
  ListingStatusSchema,
} from '@fish/contracts/listings/schema'
import { z } from 'zod'

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
 * 依赖 #74（Moderation Domain）：#74 尚未冻结 Contract，本文件**暂不定义**审核相关 DTO
 * （`reviewing`、审核时间线、人工决定端点）。#74 冻结后在此增量补充，只读查询与后台壳不受影响。
 */

// ---------------------------------------------------------------------------
// 角色
// ---------------------------------------------------------------------------

/** 用户角色。镜像 DB 枚举 `user_role`（packages/db/src/schema/users.ts），大小写不得漂移。 */
export const UserRoleSchema = z.enum(['USER', 'ADMIN'])
export type UserRole = z.infer<typeof UserRoleSchema>

/** 管理查询 / 路由路径参数的目标 id 形状（用户 / 商品 / 审计目标通用）。非 UUID 直接 404/422，不打到 SQL。 */
export const AdminTargetIdSchema = z.uuid()

/**
 * 脱敏学号：保留首尾、中段以 `*` 掩蔽（12 位学号 → `2021****0001`）。
 *
 * 不变量：保留位数首尾各**不超过 4 位**，且 4 位以上一律**至少掩蔽 4 位**。
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
  id: z.uuid(),
  /** 脱敏学号（`2021****0001`），完整学号不进协议。 */
  studentNoMasked: z.string().min(1),
  nickname: z.string(),
  campus: CampusSchema.nullable(),
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

export const AdminUserDetailSchema = z.object({
  user: AdminUserSummarySchema,
  listingStats: AdminListingStatusCountSchema,
  /** 最近 10 条针对该用户的 Admin 操作（时间倒序；空数组 = 无操作记录）。 */
  recentAuditLogs: z.array(
    z.object({
      id: z.uuid(),
      action: z.string(),
      targetType: z.string(),
      targetId: z.uuid(),
      reason: z.string().nullable(),
      createdAt: z.iso.datetime(),
    }),
  ),
})
export type AdminUserDetail = z.infer<typeof AdminUserDetailSchema>

// ---------------------------------------------------------------------------
// 商品查询
// ---------------------------------------------------------------------------

export const AdminSellerSummarySchema = z.object({
  id: z.uuid(),
  nickname: z.string(),
  campus: CampusSchema.nullable(),
})
export type AdminSellerSummary = z.infer<typeof AdminSellerSummarySchema>

export const AdminListingSummarySchema = z.object({
  id: z.uuid(),
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
  id: z.uuid(),
  title: z.string(),
  description: z.string(),
  priceCents: z.number().int().nonnegative(),
  category: ListingCategorySchema,
  condition: ListingConditionSchema,
  status: ListingStatusSchema,
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
      id: z.uuid(),
      action: z.string(),
      targetType: z.string(),
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
})
export type AdminOverview = z.infer<typeof AdminOverviewSchema>

// ---------------------------------------------------------------------------
// 审计日志
// ---------------------------------------------------------------------------

/** Admin 动作枚举。#74 落地人工审核后在此追加 `MODERATION_DECISION`。 */
export const AdminAuditActionSchema = z.enum(['ADMIN_PROMOTED'])
export type AdminAuditAction = z.infer<typeof AdminAuditActionSchema>

export const AdminAuditTargetTypeSchema = z.enum(['USER', 'LISTING', 'MODERATION_RECORD'])
export type AdminAuditTargetType = z.infer<typeof AdminAuditTargetTypeSchema>

export const AdminAuditLogEntrySchema = z.object({
  id: z.uuid(),
  /** 操作者；用户被删或初始化提升（无既有 actor）时为 `null`。 */
  actor: z
    .object({
      id: z.uuid(),
      nickname: z.string(),
    })
    .nullable(),
  action: AdminAuditActionSchema,
  targetType: AdminAuditTargetTypeSchema,
  targetId: z.uuid(),
  /** 脱敏快照（不存密码 / Cookie / 完整学号）。 */
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  reason: z.string().nullable(),
  requestId: z.string().nullable(),
  createdAt: z.iso.datetime(),
})
export type AdminAuditLogEntry = z.infer<typeof AdminAuditLogEntrySchema>

export const AdminAuditLogPageSchema = z.object({
  items: z.array(AdminAuditLogEntrySchema),
  nextCursor: z.string().nullable(),
})
export type AdminAuditLogPage = z.infer<typeof AdminAuditLogPageSchema>

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
  sellerId: z.uuid().optional(),
  /**
   * 时间段（**左闭右开**：`>= createdFrom` 且 `< createdTo`，与 `store.ts` 的条件一致）；
   * ISO datetime。取「含边界」的客户端会丢掉恰好等于 `createdTo` 的那条记录。
   */
  createdFrom: z.iso.datetime().optional(),
  createdTo: z.iso.datetime().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

export const AdminAuditLogsQuerySchema = z.strictObject({
  actorId: z.uuid().optional(),
  action: AdminAuditActionSchema.optional(),
  targetType: AdminAuditTargetTypeSchema.optional(),
  targetId: z.uuid().optional(),
  /** 同 `AdminListingsQuerySchema`：左闭右开。 */
  createdFrom: z.iso.datetime().optional(),
  createdTo: z.iso.datetime().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})
