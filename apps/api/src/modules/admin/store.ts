import type {
  AdminAuditAction,
  AdminAuditTargetType,
  AdminListingStatusCount,
  UserRole,
} from '@fish/contracts/admin/schema'
import type { AuthStatus } from '@fish/contracts/auth/user'
import type { ListingStatus } from '@fish/contracts/listings/schema'
import type { Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { jsonParam } from '@fish/db/json'
import { adminAuditLogs } from '@fish/db/schema/admin'
import { listingImages, listings } from '@fish/db/schema/listings'
import { sessions } from '@fish/db/schema/sessions'
import { transactions } from '@fish/db/schema/transactions'
import { users } from '@fish/db/schema/users'
import { and, asc, desc, eq, type SQL, sql } from 'drizzle-orm'
import type { ModerationStore } from '../moderation/store'
import { createdAtCursorText, cursorCondition } from './cursor'

/**
 * Admin store（#73）：管理后台的全部 SQL。
 *
 * 全部走 drizzle typed builder / `db.execute`（Bun 原生 `bun:sql`），不引入 pg / postgres。
 * 读模型与 #6 / #7 / #12 的既有口径保持一致：
 * - 封面只认 `sort_order = 0`（#6 契约 §1）；
 * - 时间倒序 `created_at DESC, id DESC` 游标分页（列表接口）；
 * - jsonb 列（审计的 before/after）用 typed builder 读 → 对象；写经 `jsonParam()` 避免
 *   bun-sql 双重 stringify（见 `@fish/db/json` 的实测说明）。
 */

/** 与 profile/store.ts 相同的裸 SQL 行归一：`db.execute` 的返回形状是 `{ rows }`。 */
function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}

export interface UserSummaryRow {
  id: string
  /** #86 后微信注册的用户没有学号 → `null`。 */
  studentNo: string | null
  nickname: string
  authStatus: string
  role: string
  createdAt: Date
  /** 微秒精度的 `created_at` 文本（游标用，见 cursor.ts）。 */
  createdAtCursor: string
  listingCount: number
  lastActivityAt: Date | null
}

export interface ListingSummaryRow {
  id: string
  title: string
  priceCents: number
  category: string
  condition: string
  status: string
  createdAt: Date
  /** 微秒精度的 `created_at` 文本（游标用，见 cursor.ts）。 */
  createdAtCursor: string
  coverObjectKey: string | null
  sellerId: string
  sellerNickname: string
}

export interface ListingImageRow {
  objectKey: string
  sortOrder: number
}

export interface AuditLogRow {
  id: string
  actorUserId: string | null
  actorNickname: string | null
  action: string
  targetType: string
  targetId: string
  /** jsonb 由 typed builder 解析成对象；合同/历史脏值态由 service 兜底。 */
  before: unknown
  after: unknown
  reason: string | null
  requestId: string | null
  createdAt: Date
  /** 微秒精度的 `created_at` 文本（游标用，见 cursor.ts）。 */
  createdAtCursor: string
}

export interface AuditLogSummaryRow {
  id: string
  action: string
  targetType: string
  targetId: string
  reason: string | null
  createdAt: Date
}

export interface ModerationRecordRow {
  id: string
  listingId: string | null
  sellerId: string
  action: string
  titleSnapshot: string
  descriptionSnapshot: string
  decision: string
  matchedRules: string[]
  matchedTermsMasked: string[]
  ruleVersion: string
  createdAt: Date
  createdAtCursor: string
}

export interface ModerationListingRow {
  id: string
  title: string
  description: string
  status: string
  moderationStatus: string
  moderationReason: string | null
  createdAt: Date
}

export interface ModerationSellerRow {
  id: string
  nickname: string
}

export interface ModerationQueueRow {
  id: string
  createdAtCursor: string
  record: ModerationRecordRow
  listing: ModerationListingRow
  seller: ModerationSellerRow
}

export interface ModerationDetailRow {
  record: ModerationRecordRow
  listing: ModerationListingRow
  seller: ModerationSellerRow
  history: ModerationRecordRow[]
  humanDecision: {
    decision: 'ALLOW' | 'BLOCK'
    reason: string
    actorId: string | null
    actorNickname: string | null
    decidedAt: Date
  } | null
}

export interface AdminTransactionRow {
  id: string
  listingId: string
  listingTitle: string
  buyerId: string
  buyerNickname: string
  sellerId: string
  sellerNickname: string
  amountCents: number
  status: string
  buyerConfirmedAt: Date | null
  sellerConfirmedAt: Date | null
  completedAt: Date | null
  cancelledAt: Date | null
  createdAt: Date
  updatedAt: Date
  createdAtCursor: string
}

export interface OverviewRow {
  totalUsers: number
  newUsersLast24h: number
  activeListings: number
  completedTransactions: number
}

export type ListUsersCriteria = {
  q: string | undefined
  authStatus: AuthStatus | undefined
  role: UserRole | undefined
  cursor: { createdAt: string; id: string } | null
  limit: number
}

export type ListListingsCriteria = {
  q: string | undefined
  status: ListingStatus | undefined
  sellerId: string | undefined
  /**
   * 时间段（含边界）。只接受 ISO datetime（router 已在 zod 校验）；SQL 用
   * `>=` / `<`（左闭右开），避免同一毫秒的边界行在翻页时重复 / 漏掉。
   */
  createdFrom: Date | undefined
  createdTo: Date | undefined
  cursor: { createdAt: string; id: string } | null
  limit: number
}

export type ListAuditLogsCriteria = {
  actorId: string | undefined
  action: AdminAuditAction | undefined
  targetType: AdminAuditTargetType | undefined
  targetId: string | undefined
  createdFrom: Date | undefined
  createdTo: Date | undefined
  cursor: { createdAt: string; id: string } | null
  limit: number
}

export type ListModerationQueueCriteria = {
  cursor: { createdAt: string; id: string } | null
  limit: number
}

export type ListAdminTransactionsCriteria = {
  q: string | undefined
  status: string | undefined
  buyerId: string | undefined
  sellerId: string | undefined
  listingId: string | undefined
  createdFrom: Date | undefined
  createdTo: Date | undefined
  cursor: { createdAt: string; id: string } | null
  limit: number
}

export interface AdminStore {
  isAdmin(userId: string): Promise<boolean>
  /** 用户列表（默认 `createdAt DESC, id DESC`；游标即"起点行之后"）。 */
  listUsers(criteria: ListUsersCriteria): Promise<UserSummaryRow[]>
  findUserSummary(userId: string): Promise<UserSummaryRow | null>
  /** 用户商品状态分桶（四桶合计 = 该用户发布商品总数）。 */
  listingStatusCounts(userId: string): Promise<AdminListingStatusCount>
  listListings(criteria: ListListingsCriteria): Promise<ListingSummaryRow[]>
  findListingDetail(listingId: string): Promise<{
    listing: Omit<
      ListingSummaryRow,
      'coverObjectKey' | 'createdAtCursor' | 'sellerId' | 'sellerNickname'
    > & {
      description: string
      updatedAt: Date
      urgent: boolean
      negotiable: boolean
      free: boolean
      seller: { id: string; nickname: string }
    }
    images: ListingImageRow[]
  } | null>
  getOverview(): Promise<OverviewRow>
  listAuditLogs(criteria: ListAuditLogsCriteria): Promise<AuditLogRow[]>
  listModerationQueue(criteria: ListModerationQueueCriteria): Promise<ModerationQueueRow[]>
  getModerationDetail(recordId: string): Promise<ModerationDetailRow | null>
  decideModeration(input: {
    recordId: string
    actorUserId: string
    decision: 'ALLOW' | 'BLOCK'
    reason: string
    requestId: string
  }): Promise<'applied' | 'idempotent' | 'not-found' | 'conflict' | 'idempotency-conflict'>
  listAdminTransactions(criteria: ListAdminTransactionsCriteria): Promise<AdminTransactionRow[]>
  /** 某个目标对象最近的 Admin 操作（时间倒序）。 */
  recentAuditLogs(
    targetType: AdminAuditTargetType,
    targetId: string,
    limit: number,
  ): Promise<AuditLogSummaryRow[]>
}

function userSearchCondition(alias: string, q: string): SQL {
  // 学号精确匹配或昵称前缀搜索（设计 §4.2）。LIKE 通配符 `% _ \` 先转义，
  // 否则昵称里的 `_` 会被当成单字符通配（与 #6 的 ILIKE 同一取舍）。
  const escaped = q.replace(/[\\%_]/g, '\\$&')
  return sql`(${sql.raw(`${alias}.student_no`)} = ${q} OR ${sql.raw(`${alias}.nickname`)} ILIKE ${`${escaped}%`})`
}

/** 关键词搜索：title / description 子串（与 #6 feed 同口径 ILIKE，`%_\` 转义）。 */
function listingSearchCondition(alias: string, q: string): SQL {
  const escaped = q.replace(/[\\%_]/g, '\\$&')
  return sql`(${sql.raw(`${alias}.title`)} ILIKE ${`%${escaped}%`} OR ${sql.raw(`${alias}.description`)} ILIKE ${`%${escaped}%`})`
}

/** 用户摘要共用的 SQL SELECT 实体（列表 / 详情都取同一套列，避免口径漂移）。 */
const userSummarySelectSql = sql`
  u.id AS id, u.student_no AS student_no, u.nickname AS nickname,
  u.auth_status::text AS auth_status, u.role::text AS role,
  u.created_at AS created_at,
  ${createdAtCursorText(sql`u.created_at`)} AS created_at_cursor,
  (SELECT count(*)::int FROM ${listings} l WHERE l.seller_id = u.id) AS listing_count,
  (SELECT max(s.created_at) FROM ${sessions} s WHERE s.user_id = u.id) AS last_activity_at
`

function rowsToUserSummaries(rows: Record<string, unknown>[]): UserSummaryRow[] {
  return rows.map((row) => ({
    id: String(row.id),
    // NULL（微信用户）必须保持 null：String(null) 会得到 "null" 再被脱敏成 "n**l"。
    studentNo: (row.student_no as string | null) ?? null,
    nickname: String(row.nickname),
    authStatus: String(row.auth_status),
    role: String(row.role),
    createdAt: new Date(row.created_at as string | Date),
    createdAtCursor: String(row.created_at_cursor),
    listingCount: Number(row.listing_count),
    lastActivityAt: (row.last_activity_at as string | Date | null)
      ? new Date(row.last_activity_at as string | Date)
      : null,
  }))
}

function jsonStringArray(value: unknown): string[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === 'string')
    : []
}

function moderationRecordFromRow(row: Record<string, unknown>): ModerationRecordRow {
  return {
    id: String(row.id),
    listingId: (row.listing_id as string | null) ?? null,
    sellerId: String(row.seller_id),
    action: String(row.action),
    titleSnapshot: String(row.title_snapshot),
    descriptionSnapshot: String(row.description_snapshot),
    decision: String(row.decision),
    matchedRules: jsonStringArray(row.matched_rules),
    matchedTermsMasked: jsonStringArray(row.matched_terms_masked),
    ruleVersion: String(row.rule_version),
    createdAt: new Date(row.created_at as string | Date),
    createdAtCursor: String(row.created_at_cursor ?? row.created_at),
  }
}

function moderationListingFromRow(row: Record<string, unknown>): ModerationListingRow {
  return {
    id: String(row.listing_id ?? row.id),
    title: String(row.listing_title ?? row.title),
    description: String(row.listing_description ?? row.description),
    status: String(row.listing_status ?? row.status),
    moderationStatus: String(row.moderation_status),
    moderationReason: (row.moderation_reason as string | null) ?? null,
    createdAt: new Date((row.listing_created_at ?? row.created_at) as string | Date),
  }
}

export function createSqlAdminStore(db: Db, moderation: ModerationStore): AdminStore {
  return {
    async isAdmin(userId) {
      const rows = await db
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
      return rows[0]?.role === 'ADMIN'
    },

    async listUsers(criteria) {
      const conditions: SQL[] = []
      if (criteria.q) conditions.push(userSearchCondition('u', criteria.q))
      if (criteria.authStatus)
        conditions.push(sql`${sql.raw('u.auth_status')} = ${criteria.authStatus}`)
      if (criteria.role) conditions.push(sql`${sql.raw('u.role')} = ${criteria.role}`)
      if (criteria.cursor) {
        // 与 ORDER BY 同向：cursor 是"本页起点"，下一页从它**之后**取。
        conditions.push(
          cursorCondition(
            sql`${sql.raw('u.created_at')}`,
            sql`${sql.raw('u.id')}`,
            criteria.cursor,
          ),
        )
      }

      const where = conditions.length > 0 ? sql` WHERE ${sql.join(conditions, sql` AND `)}` : sql``
      // 裸参数化 SQL（而非 typed builder）：drizzle + bun-sql 下 typed builder 的**相关子查询**
      //（listings / sessions 计数）会静默算错（实测返回 0），裸 SQL 结果正确（profile store 同款
      // 取舍）。多取一行用于判断“还有没有下一页”（与 #6 一致：不另给 hasMore / total）。
      const result = await db.execute(sql`
        SELECT ${userSummarySelectSql}
        FROM ${users} u
        ${where}
        ORDER BY u.created_at DESC, u.id DESC
        LIMIT ${criteria.limit + 1}
      `)
      return rowsToUserSummaries(rowsOf(result))
    },

    async findUserSummary(userId) {
      const result = await db.execute(sql`
        SELECT ${userSummarySelectSql}
        FROM ${users} u
        WHERE u.id = ${userId}
        LIMIT 1
      `)
      const row = rowsOf(result)[0]
      return row ? (rowsToUserSummaries([row])[0] ?? null) : null
    },

    async listingStatusCounts(userId) {
      const result = await db.execute(sql`
        SELECT
          count(*) FILTER (WHERE status = 'ACTIVE')::int   AS active,
          count(*) FILTER (WHERE status = 'RESERVED')::int AS reserved,
          count(*) FILTER (WHERE status = 'SOLD')::int     AS sold,
          count(*) FILTER (WHERE status = 'OFFLINE')::int  AS offline
        FROM ${listings}
        WHERE seller_id = ${userId}
      `)
      const row = rowsOf(result)[0]
      if (!row) throw new Error('Admin 商品状态统计未返回行')
      return {
        ACTIVE: Number(row.active),
        RESERVED: Number(row.reserved),
        SOLD: Number(row.sold),
        OFFLINE: Number(row.offline),
      }
    },

    async listListings(criteria) {
      const conditions: SQL[] = []
      if (criteria.q) conditions.push(listingSearchCondition('l', criteria.q))
      if (criteria.status) conditions.push(sql`${sql.raw('l.status')} = ${criteria.status}`)
      if (criteria.sellerId) conditions.push(sql`${sql.raw('l.seller_id')} = ${criteria.sellerId}`)
      if (criteria.createdFrom) {
        conditions.push(sql`${sql.raw('l.created_at')} >= ${criteria.createdFrom}`)
      }
      if (criteria.createdTo) {
        // 左闭右开：`>= from AND < to`，同一毫秒的边界行不会重复 / 漏掉。
        conditions.push(sql`${sql.raw('l.created_at')} < ${criteria.createdTo}`)
      }
      if (criteria.cursor) {
        conditions.push(
          cursorCondition(
            sql`${sql.raw('l.created_at')}`,
            sql`${sql.raw('l.id')}`,
            criteria.cursor,
          ),
        )
      }

      const where = conditions.length > 0 ? sql` WHERE ${sql.join(conditions, sql` AND `)}` : sql``
      // 裸参数化 SQL（相关子查询取封面在 typed builder 下会静默算错，与 listUsers 同因）。
      const result = await db.execute(sql`
        SELECT l.id AS id, l.title AS title, l.price_cents AS price_cents,
               l.category::text AS category, l.condition::text AS condition,
               l.status::text AS status, l.created_at AS created_at,
               ${createdAtCursorText(sql`l.created_at`)} AS created_at_cursor,
               (SELECT li.object_key FROM ${listingImages} li
                 WHERE li.listing_id = l.id AND li.sort_order = 0 LIMIT 1) AS cover_object_key,
               u.id AS seller_id, u.nickname AS seller_nickname
        FROM ${listings} l
        JOIN ${users} u ON u.id = l.seller_id
        ${where}
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT ${criteria.limit + 1}
      `)
      return rowsOf(result).map((row) => ({
        id: String(row.id),
        title: String(row.title),
        priceCents: Number(row.price_cents),
        category: String(row.category),
        condition: String(row.condition),
        status: String(row.status),
        createdAt: new Date(row.created_at as string | Date),
        createdAtCursor: String(row.created_at_cursor),
        coverObjectKey: (row.cover_object_key as string | null) ?? null,
        sellerId: String(row.seller_id),
        sellerNickname: String(row.seller_nickname),
      }))
    },

    async findListingDetail(listingId) {
      const listingRows = await db
        .select({
          id: listings.id,
          title: listings.title,
          description: listings.description,
          priceCents: listings.priceCents,
          category: sql<string>`${listings.category}::text`,
          condition: sql<string>`${listings.condition}::text`,
          status: sql<string>`${listings.status}::text`,
          createdAt: listings.createdAt,
          updatedAt: listings.updatedAt,
          urgent: listings.urgent,
          negotiable: listings.negotiable,
          free: listings.free,
          seller: {
            id: users.id,
            nickname: users.nickname,
          },
        })
        .from(listings)
        .innerJoin(users, eq(users.id, listings.sellerId))
        .where(eq(listings.id, listingId))
        .limit(1)

      const listing = listingRows[0]
      if (!listing) return null

      const imageRows = await db
        .select({ objectKey: listingImages.objectKey, sortOrder: listingImages.sortOrder })
        .from(listingImages)
        .where(eq(listingImages.listingId, listingId))
        .orderBy(asc(listingImages.sortOrder))

      return { listing, images: imageRows }
    },

    async getOverview() {
      const result = await db.execute(sql`
        SELECT
          (SELECT count(*)::int FROM ${users})                                   AS total_users,
          (SELECT count(*)::int FROM ${users}
            WHERE created_at >= now() - interval '24 hours')                     AS new_users_24h,
          (SELECT count(*)::int FROM ${listings} WHERE status = 'ACTIVE')        AS active_listings,
          (SELECT count(*)::int FROM ${transactions} WHERE status = 'COMPLETED') AS completed_transactions
      `)
      const row = rowsOf(result)[0]
      if (!row) throw new Error('Admin 概览查询未返回行')
      return {
        totalUsers: Number(row.total_users),
        newUsersLast24h: Number(row.new_users_24h),
        activeListings: Number(row.active_listings),
        completedTransactions: Number(row.completed_transactions),
      }
    },

    async listAuditLogs(criteria) {
      const conditions: SQL[] = []
      if (criteria.actorId) conditions.push(eq(adminAuditLogs.actorUserId, criteria.actorId))
      if (criteria.action) conditions.push(eq(adminAuditLogs.action, criteria.action))
      if (criteria.targetType) conditions.push(eq(adminAuditLogs.targetType, criteria.targetType))
      if (criteria.targetId) conditions.push(eq(adminAuditLogs.targetId, criteria.targetId))
      if (criteria.createdFrom) {
        conditions.push(sql`${adminAuditLogs.createdAt} >= ${criteria.createdFrom}`)
      }
      if (criteria.createdTo) {
        conditions.push(sql`${adminAuditLogs.createdAt} < ${criteria.createdTo}`)
      }
      if (criteria.cursor) {
        conditions.push(
          cursorCondition(
            sql`${adminAuditLogs.createdAt}`,
            sql`${adminAuditLogs.id}`,
            criteria.cursor,
          ),
        )
      }

      return db
        .select({
          id: adminAuditLogs.id,
          actorUserId: adminAuditLogs.actorUserId,
          actorNickname: users.nickname,
          action: sql<string>`${adminAuditLogs.action}::text`,
          targetType: sql<string>`${adminAuditLogs.targetType}::text`,
          targetId: adminAuditLogs.targetId,
          before: adminAuditLogs.before,
          after: adminAuditLogs.after,
          reason: adminAuditLogs.reason,
          requestId: adminAuditLogs.requestId,
          createdAt: adminAuditLogs.createdAt,
          createdAtCursor: createdAtCursorText(sql`${adminAuditLogs.createdAt}`),
        })
        .from(adminAuditLogs)
        .leftJoin(users, eq(users.id, adminAuditLogs.actorUserId))
        .where(and(...conditions))
        .orderBy(desc(adminAuditLogs.createdAt), desc(adminAuditLogs.id))
        .limit(criteria.limit + 1)
    },

    async listModerationQueue(criteria) {
      const conditions: SQL[] = [sql`l.moderation_status = 'REVIEW'`]
      if (criteria.cursor) {
        conditions.push(cursorCondition(sql`r.created_at`, sql`r.id`, criteria.cursor))
      }

      const result = await db.execute(sql`
        SELECT r.id, r.listing_id, r.seller_id, r.action,
               r.title_snapshot, r.description_snapshot, r.decision::text AS decision,
               r.matched_rules, r.matched_terms_masked, r.rule_version, r.created_at,
               ${createdAtCursorText(sql`r.created_at`)} AS created_at_cursor,
               l.id AS listing_id, l.title AS listing_title, l.description AS listing_description,
               l.status::text AS listing_status, l.moderation_status::text AS moderation_status,
               l.moderation_reason, l.created_at AS listing_created_at,
               u.id AS seller_id, u.nickname AS seller_nickname
        FROM listing_moderation_records r
        JOIN listings l ON l.id = r.listing_id
        JOIN users u ON u.id = r.seller_id
        WHERE ${sql.join(conditions, sql` AND `)}
          AND r.decision = 'REVIEW'
          AND r.id = (
            SELECT latest.id FROM listing_moderation_records latest
            WHERE latest.listing_id = r.listing_id
              AND latest.decision = 'REVIEW'
            ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1
          )
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ${criteria.limit + 1}
      `)

      return rowsOf(result).map((row) => ({
        id: String(row.id),
        createdAtCursor: String(row.created_at_cursor),
        record: moderationRecordFromRow(row),
        listing: moderationListingFromRow(row),
        seller: { id: String(row.seller_id), nickname: String(row.seller_nickname) },
      }))
    },

    async getModerationDetail(recordId) {
      const initialIdResult = await db.execute(sql`
        SELECT target_id
        FROM admin_audit_logs
        WHERE action = 'MODERATION_DECISION'
          AND target_type = 'MODERATION_RECORD'
          AND after->>'manualRecordId' = ${recordId}
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `)
      const effectiveRecordId =
        (rowsOf(initialIdResult)[0]?.target_id as string | undefined) ?? recordId

      const result = await db.execute(sql`
        SELECT r.id, r.listing_id, r.seller_id, r.action,
               r.title_snapshot, r.description_snapshot, r.decision::text AS decision,
               r.matched_rules, r.matched_terms_masked, r.rule_version, r.created_at,
               ${createdAtCursorText(sql`r.created_at`)} AS created_at_cursor,
               l.id AS listing_id, l.title AS listing_title, l.description AS listing_description,
               l.status::text AS listing_status, l.moderation_status::text AS moderation_status,
               l.moderation_reason, l.created_at AS listing_created_at,
               u.id AS seller_id, u.nickname AS seller_nickname
        FROM listing_moderation_records r
        JOIN listings l ON l.id = r.listing_id
        JOIN users u ON u.id = r.seller_id
        WHERE r.id = ${effectiveRecordId}
        LIMIT 1
      `)
      const row = rowsOf(result)[0]
      if (!row) return null

      const historyResult = await db.execute(sql`
        SELECT r.id, r.listing_id, r.seller_id, r.action,
               r.title_snapshot, r.description_snapshot, r.decision::text AS decision,
               r.matched_rules, r.matched_terms_masked, r.rule_version, r.created_at,
               ${createdAtCursorText(sql`r.created_at`)} AS created_at_cursor
        FROM listing_moderation_records r
        WHERE r.listing_id = ${row.listing_id}
        ORDER BY r.created_at ASC, r.id ASC
      `)
      const audit = await db.execute(sql`
        SELECT a.after, a.reason, a.created_at AS decided_at,
               u.id AS actor_id, u.nickname AS actor_nickname
        FROM admin_audit_logs a
        LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE a.action = 'MODERATION_DECISION'
          AND a.target_type = 'MODERATION_RECORD'
          AND a.target_id = ${effectiveRecordId}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT 1
      `)
      const auditRow = rowsOf(audit)[0]
      const after = auditRow
        ? typeof auditRow.after === 'string'
          ? JSON.parse(auditRow.after)
          : auditRow.after
        : null
      const humanDecision =
        auditRow && after && typeof after === 'object' && (after as { decision?: unknown }).decision
          ? {
              decision: (after as { decision: 'ALLOW' | 'BLOCK' }).decision,
              reason: String(auditRow.reason ?? ''),
              actorId: (auditRow.actor_id as string | null) ?? null,
              actorNickname: (auditRow.actor_nickname as string | null) ?? null,
              decidedAt: new Date(auditRow.decided_at as string | Date),
            }
          : null

      return {
        record: moderationRecordFromRow(row),
        listing: moderationListingFromRow(row),
        seller: { id: String(row.seller_id), nickname: String(row.seller_nickname) },
        history: rowsOf(historyResult).map(moderationRecordFromRow),
        humanDecision,
      }
    },

    async decideModeration(input) {
      return db.transaction(async (tx) => {
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(hashtext(${`${input.recordId}:${input.requestId}`}))
        `)
        const existingRequest = await tx.execute(sql`
          SELECT after, reason, actor_user_id
          FROM admin_audit_logs
          WHERE action = 'MODERATION_DECISION'
            AND target_type = 'MODERATION_RECORD'
            AND target_id = ${input.recordId}
            AND request_id = ${input.requestId}
          LIMIT 1
        `)
        const existing = rowsOf(existingRequest)[0]
        if (existing) {
          const after =
            typeof existing.after === 'string' ? JSON.parse(existing.after) : existing.after
          const previousDecision =
            after && typeof after === 'object' ? (after as { decision?: unknown }).decision : null
          const previousReason = existing.reason == null ? null : String(existing.reason)
          return previousDecision === input.decision && previousReason === input.reason
            ? ('idempotent' as const)
            : ('idempotency-conflict' as const)
        }

        const result = await moderation.decideWithin(tx, {
          recordId: input.recordId,
          decision: input.decision,
          reason: input.reason,
        })
        if (result.kind !== 'applied') return result.kind

        await tx.insert(adminAuditLogs).values({
          id: newId(),
          actorUserId: input.actorUserId,
          action: 'MODERATION_DECISION',
          targetType: 'MODERATION_RECORD',
          targetId: input.recordId,
          before: jsonParam({ moderationStatus: result.previousStatus }),
          after: jsonParam({
            decision: input.decision,
            manualRecordId: result.manualRecordId,
          }),
          reason: input.reason,
          requestId: input.requestId,
        })
        return 'applied' as const
      })
    },

    async listAdminTransactions(criteria) {
      const conditions: SQL[] = []
      if (criteria.q) conditions.push(listingSearchCondition('l', criteria.q))
      if (criteria.status) conditions.push(sql`t.status = ${criteria.status}`)
      if (criteria.buyerId) conditions.push(sql`t.buyer_id = ${criteria.buyerId}`)
      if (criteria.sellerId) conditions.push(sql`t.seller_id = ${criteria.sellerId}`)
      if (criteria.listingId) conditions.push(sql`t.listing_id = ${criteria.listingId}`)
      if (criteria.createdFrom) conditions.push(sql`t.created_at >= ${criteria.createdFrom}`)
      if (criteria.createdTo) conditions.push(sql`t.created_at < ${criteria.createdTo}`)
      if (criteria.cursor)
        conditions.push(cursorCondition(sql`t.created_at`, sql`t.id`, criteria.cursor))
      const where = conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``
      const result = await db.execute(sql`
        SELECT t.id, t.listing_id, l.title AS listing_title,
               t.buyer_id, b.nickname AS buyer_nickname,
               t.seller_id, s.nickname AS seller_nickname,
               t.amount_cents, t.status::text AS status,
               t.buyer_confirmed_at, t.seller_confirmed_at, t.completed_at,
               t.cancelled_at, t.created_at, t.updated_at,
               ${createdAtCursorText(sql`t.created_at`)} AS created_at_cursor
        FROM transactions t
        JOIN listings l ON l.id = t.listing_id
        JOIN users b ON b.id = t.buyer_id
        JOIN users s ON s.id = t.seller_id
        ${where}
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT ${criteria.limit + 1}
      `)
      return rowsOf(result).map((row) => ({
        id: String(row.id),
        listingId: String(row.listing_id),
        listingTitle: String(row.listing_title),
        buyerId: String(row.buyer_id),
        buyerNickname: String(row.buyer_nickname),
        sellerId: String(row.seller_id),
        sellerNickname: String(row.seller_nickname),
        amountCents: Number(row.amount_cents),
        status: String(row.status),
        buyerConfirmedAt: row.buyer_confirmed_at
          ? new Date(row.buyer_confirmed_at as string | Date)
          : null,
        sellerConfirmedAt: row.seller_confirmed_at
          ? new Date(row.seller_confirmed_at as string | Date)
          : null,
        completedAt: row.completed_at ? new Date(row.completed_at as string | Date) : null,
        cancelledAt: row.cancelled_at ? new Date(row.cancelled_at as string | Date) : null,
        createdAt: new Date(row.created_at as string | Date),
        updatedAt: new Date(row.updated_at as string | Date),
        createdAtCursor: String(row.created_at_cursor),
      }))
    },

    async recentAuditLogs(targetType, targetId, limit) {
      return db
        .select({
          id: adminAuditLogs.id,
          action: sql<string>`${adminAuditLogs.action}::text`,
          targetType: sql<string>`${adminAuditLogs.targetType}::text`,
          targetId: adminAuditLogs.targetId,
          reason: adminAuditLogs.reason,
          createdAt: adminAuditLogs.createdAt,
        })
        .from(adminAuditLogs)
        .where(
          and(eq(adminAuditLogs.targetType, targetType), eq(adminAuditLogs.targetId, targetId)),
        )
        .orderBy(desc(adminAuditLogs.createdAt), desc(adminAuditLogs.id))
        .limit(limit)
    },
  }
}
