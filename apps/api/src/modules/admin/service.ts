import type {
  AdminAuditAction,
  AdminAuditLogPage,
  AdminAuditTargetType,
  AdminCapability,
} from '@fish/contracts/admin/schema'
import {
  AdminAuditLogEntrySchema,
  AdminAuditLogPageSchema,
  type AdminListingDetail,
  AdminListingDetailSchema,
  type AdminListingSummaryPage,
  AdminListingSummaryPageSchema,
  type AdminMe,
  AdminMeResponseSchema,
  type AdminOverview,
  AdminOverviewSchema,
  type AdminUserDetail,
  AdminUserDetailSchema,
  type AdminUserSummaryPage,
  AdminUserSummaryPageSchema,
  maskStudentNo,
  type UserRole,
} from '@fish/contracts/admin/schema'
import type { AuthStatus, Me } from '@fish/contracts/auth/user'
import type { ListingStatus } from '@fish/contracts/listings/schema'
import type { MediaStorage } from '../uploads/storage'
import { decodeCursor, encodeCursor } from './cursor'
import { AdminError } from './errors'
import type {
  AdminStore,
  AuditLogRow,
  AuditLogSummaryRow,
  ListingSummaryRow,
  UserSummaryRow,
} from './store'

/**
 * Admin service（#73，设计 §6）：权限校验之后 + 数据层之前的业务编排。
 *
 * - 只从 store 产出的行构造 DTO，URL 由共享的 `storage.publicUrl` 拼（与 #6 同一实现，
 *   后台展示的图片地址与 feed / 详情必须一致）。
 * - DTO 一律经契约 zod 校验；单条脏数据记日志跳过（决策 C），不让整个后台列表 500。
 * - 审计日志的 `before` / `after` 只透传**已脱敏**的快照；本服务不写入任何敏感字段。
 */

/** `GET /admin/me` 返回的当前可用能力。moderation 写入能力等 #74 落地后再加。 */
const ADMIN_CAPABILITIES: AdminCapability[] = [
  'USERS_READ',
  'LISTINGS_READ',
  'OVERVIEW_READ',
  'AUDIT_LOGS_READ',
]

export type AdminUserListQuery = {
  q?: string
  authStatus?: AuthStatus
  role?: UserRole
  cursor?: string
  limit: number
}

export type AdminListingListQuery = {
  q?: string
  status?: ListingStatus
  sellerId?: string
  createdFrom?: string
  createdTo?: string
  cursor?: string
  limit: number
}

export type AdminAuditLogListQuery = {
  actorId?: string
  action?: AdminAuditAction
  targetType?: AdminAuditTargetType
  targetId?: string
  createdFrom?: string
  createdTo?: string
  cursor?: string
  limit: number
}

export interface AdminService {
  getMe(me: Me): Promise<{ admin: AdminMe; capabilities: AdminCapability[] }>
  listUsers(query: AdminUserListQuery): Promise<AdminUserSummaryPage>
  getUserDetail(userId: string): Promise<AdminUserDetail>
  listListings(query: AdminListingListQuery): Promise<AdminListingSummaryPage>
  getListingDetail(listingId: string): Promise<AdminListingDetail>
  getOverview(): Promise<AdminOverview>
  listAuditLogs(query: AdminAuditLogListQuery): Promise<AdminAuditLogPage>
}

function adminMeOf(me: Me): { admin: AdminMe; capabilities: AdminCapability[] } {
  return AdminMeResponseSchema.parse({
    admin: { ...me, role: 'ADMIN' },
    capabilities: ADMIN_CAPABILITIES,
  })
}

function toUserSummary(row: UserSummaryRow) {
  return AdminUserSummaryPageSchema.shape.items.element.safeParse({
    id: row.id,
    studentNoMasked: maskStudentNo(row.studentNo),
    nickname: row.nickname,
    campus: row.campus,
    authStatus: row.authStatus,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
    listingCount: row.listingCount,
    lastActivityAt: row.lastActivityAt?.toISOString() ?? null,
  })
}

function toListingSummary(row: ListingSummaryRow, storage: MediaStorage) {
  return AdminListingSummaryPageSchema.shape.items.element.safeParse({
    id: row.id,
    title: row.title,
    priceCents: row.priceCents,
    category: row.category,
    condition: row.condition,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    coverUrl: row.coverObjectKey ? storage.publicUrl(row.coverObjectKey) : null,
    seller: { id: row.sellerId, nickname: row.sellerNickname, campus: row.sellerCampus },
  })
}

function toAuditLogEntry(row: AuditLogRow) {
  return AdminAuditLogEntrySchema.safeParse({
    id: row.id,
    actor:
      row.actorUserId && row.actorNickname != null
        ? { id: row.actorUserId, nickname: row.actorNickname }
        : null,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    before: row.before ?? null,
    after: row.after ?? null,
    reason: row.reason,
    requestId: row.requestId,
    createdAt: row.createdAt.toISOString(),
  })
}

function toAuditLogSummary(row: AuditLogSummaryRow) {
  return {
    id: row.id,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  }
}

/**
 * 把 store 返回的 `limit + 1` 行切成 `{ items, nextCursor }`。
 * 多取的那一行只用于判断"还有没有下一页"，不返回（与 #6 一致：不另给 hasMore / total）。
 */
function pageOf<T extends { createdAtCursor: string; id: string }>(
  rows: T[],
  limit: number,
  pick: (row: T) => unknown,
): { items: unknown[]; nextCursor: string | null } {
  const hasMore = rows.length > limit
  const items = rows.slice(0, limit)
  const last = items[items.length - 1]
  return {
    items: items.map((row) => pick(row)).filter((item) => item !== null),
    nextCursor: hasMore && last ? encodeCursor(last.createdAtCursor, last.id) : null,
  }
}

export function createAdminService({
  store,
  storage,
}: {
  store: AdminStore
  storage: MediaStorage
}): AdminService {
  return {
    async getMe(me) {
      // requireAdmin 已确认当前会话是 ADMIN，这里直接产出；普通用户到不了这行。
      return adminMeOf(me)
    },

    async listUsers(query) {
      const cursor = query.cursor ? decodeCursor(query.cursor) : null
      if (query.cursor && !cursor) throw invalidCursor()

      const rows = await store.listUsers({
        q: query.q,
        authStatus: query.authStatus,
        role: query.role,
        cursor,
        limit: query.limit,
      })

      const page = pageOf(rows, query.limit, (row) => toUserSummary(row).data ?? null)
      return AdminUserSummaryPageSchema.parse(page)
    },

    async getUserDetail(userId) {
      const summary = await store.findUserSummary(userId)
      if (!summary) throw new AdminError('ADMIN_NOT_FOUND', 404, '用户不存在')

      const [listingStats, recentAuditLogs] = await Promise.all([
        store.listingStatusCounts(userId),
        store.recentAuditLogs('USER', userId, 10),
      ])

      const user = toUserSummary(summary)
      if (!user.success) {
        console.error('[admin] 用户详情无法映射为契约', summary.id, user.error.message)
        throw new AdminError('ADMIN_NOT_FOUND', 404, '用户不存在')
      }

      return AdminUserDetailSchema.parse({
        user: user.data,
        listingStats,
        recentAuditLogs: recentAuditLogs.map(toAuditLogSummary),
      })
    },

    async listListings(query) {
      const cursor = query.cursor ? decodeCursor(query.cursor) : null
      if (query.cursor && !cursor) throw invalidCursor()

      const rows = await store.listListings({
        q: query.q,
        status: query.status,
        sellerId: query.sellerId,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
        cursor,
        limit: query.limit,
      })

      const page = pageOf(rows, query.limit, (row) => toListingSummary(row, storage).data ?? null)
      return AdminListingSummaryPageSchema.parse(page)
    },

    async getListingDetail(listingId) {
      const found = await store.findListingDetail(listingId)
      if (!found) throw new AdminError('ADMIN_NOT_FOUND', 404, '商品不存在')

      const { listing, images } = found
      const detail = {
        id: listing.id,
        title: listing.title,
        description: listing.description,
        priceCents: listing.priceCents,
        category: listing.category,
        condition: listing.condition,
        status: listing.status,
        urgent: listing.urgent,
        negotiable: listing.negotiable,
        free: listing.free,
        createdAt: listing.createdAt.toISOString(),
        updatedAt: listing.updatedAt.toISOString(),
        images: images.map((image) => ({
          url: storage.publicUrl(image.objectKey),
          sortOrder: image.sortOrder,
        })),
        seller: listing.seller,
        recentAuditLogs: (await store.recentAuditLogs('LISTING', listingId, 10)).map(
          toAuditLogSummary,
        ),
      }

      return AdminListingDetailSchema.parse(detail)
    },

    async getOverview() {
      return AdminOverviewSchema.parse(await store.getOverview())
    },

    async listAuditLogs(query) {
      const cursor = query.cursor ? decodeCursor(query.cursor) : null
      if (query.cursor && !cursor) throw invalidCursor()

      const rows = await store.listAuditLogs({
        actorId: query.actorId,
        action: query.action,
        targetType: query.targetType,
        targetId: query.targetId,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
        cursor,
        limit: query.limit,
      })

      const page = pageOf(rows, query.limit, (row) => toAuditLogEntry(row).data ?? null)
      return AdminAuditLogPageSchema.parse(page)
    },
  }
}

function invalidCursor(): AdminError {
  return new AdminError('VALIDATION_FAILED', 422, 'cursor 无效')
}
