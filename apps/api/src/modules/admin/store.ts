import type {
  AdminAuditAction,
  AdminAuditTargetType,
  AdminListingStatusCount,
  UserRole,
} from '@fish/contracts/admin/schema'
import type { AuthStatus } from '@fish/contracts/auth/user'
import type { ListingStatus } from '@fish/contracts/listings/schema'
import type { Db } from '@fish/db/client'
import { jsonParam } from '@fish/db/json'
import { adminAuditLogs } from '@fish/db/schema/admin'
import { listingImages, listings } from '@fish/db/schema/listings'
import { sessions } from '@fish/db/schema/sessions'
import { transactions } from '@fish/db/schema/transactions'
import { users } from '@fish/db/schema/users'
import { and, asc, desc, eq, type SQL, sql } from 'drizzle-orm'

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
  studentNo: string
  nickname: string
  campus: string | null
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
  sellerCampus: string | null
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
      'coverObjectKey' | 'createdAtCursor' | 'sellerId' | 'sellerNickname' | 'sellerCampus'
    > & {
      description: string
      updatedAt: Date
      urgent: boolean
      negotiable: boolean
      free: boolean
      seller: { id: string; nickname: string; campus: string | null }
    }
    images: ListingImageRow[]
  } | null>
  getOverview(): Promise<OverviewRow>
  listAuditLogs(criteria: ListAuditLogsCriteria): Promise<AuditLogRow[]>
  /** 某个目标对象最近的 Admin 操作（时间倒序）。 */
  recentAuditLogs(
    targetType: AdminAuditTargetType,
    targetId: string,
    limit: number,
  ): Promise<AuditLogSummaryRow[]>
  /** 追加一条审计记录（写操作与审计在同一 DB 事务内的入口，见设计 §6 末尾）。 */
  insertAuditLog(input: {
    actorUserId: string | null
    action: AdminAuditAction
    targetType: AdminAuditTargetType
    targetId: string
    before: unknown
    after: unknown
    reason: string | null
    requestId: string | null
  }): Promise<void>
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

/** `created_at` 的微秒精度 UTC 文本（与 listings/store.ts 同一口径，供游标编码）。 */
export const createdAtCursorText = (col: SQL) =>
  sql<string>`to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`

/** 游标条件：`(created_at, id) < (cursor.created_at, cursor.id)`（三个列表排序同构）。 */
function cursorCondition(
  createdAtCol: SQL,
  idCol: SQL,
  cursor: { createdAt: string; id: string },
): SQL {
  return sql`(${createdAtCol}, ${idCol}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
}

/** 用户摘要共用的 SQL SELECT 实体（列表 / 详情都取同一套列，避免口径漂移）。 */
const userSummarySelectSql = sql`
  u.id AS id, u.student_no AS student_no, u.nickname AS nickname,
  u.campus AS campus, u.auth_status::text AS auth_status, u.role::text AS role,
  u.created_at AS created_at,
  ${createdAtCursorText(sql`u.created_at`)} AS created_at_cursor,
  (SELECT count(*)::int FROM ${listings} l WHERE l.seller_id = u.id) AS listing_count,
  (SELECT max(s.created_at) FROM ${sessions} s WHERE s.user_id = u.id) AS last_activity_at
`

function rowsToUserSummaries(rows: Record<string, unknown>[]): UserSummaryRow[] {
  return rows.map((row) => ({
    id: String(row.id),
    studentNo: String(row.student_no),
    nickname: String(row.nickname),
    campus: (row.campus as string | null) ?? null,
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

export function createSqlAdminStore(db: Db): AdminStore {
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
               u.id AS seller_id, u.nickname AS seller_nickname, u.campus AS seller_campus
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
        sellerCampus: (row.seller_campus as string | null) ?? null,
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
            campus: users.campus,
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

    async insertAuditLog(input) {
      // jsonb 写入必须经 jsonParam()：裸对象会被 bun-sql 双重 stringify，落库成
      // 「JSON 字符串套 JSON」（jsonb_typeof = 'string'），审计快照就变成了字符串。
      await db.insert(adminAuditLogs).values({
        actorUserId: input.actorUserId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        before: input.before === null ? null : jsonParam(input.before),
        after: input.after === null ? null : jsonParam(input.after),
        reason: input.reason,
        requestId: input.requestId,
      })
    },
  }
}
