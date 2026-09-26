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
  type AdminModerationDetail,
  AdminModerationDetailSchema,
  type AdminModerationQueue,
  AdminModerationQueueSchema,
  AdminModerationRecordSchema,
  type AdminModerationRecords,
  AdminModerationRecordsSchema,
  type AdminOverview,
  AdminOverviewSchema,
  type AdminTransactionPage,
  AdminTransactionPageSchema,
  type AdminUserDetail,
  AdminUserDetailSchema,
  type AdminUserSummaryPage,
  AdminUserSummaryPageSchema,
  maskStudentNo,
  type UserRole,
} from '@fish/contracts/admin/schema'
import type { AuthStatus, Me } from '@fish/contracts/auth/user'
import type { ListingStatus } from '@fish/contracts/listings/schema'
import { encodePublicId, PUBLIC_ID_PREFIX, type PublicIdPrefix } from '@fish/shared/public-id'
import type { MediaStorage } from '../uploads/storage'
import { decodeCursor, encodeCursor } from './cursor'
import { AdminError } from './errors'
import type {
  AdminStore,
  AdminTransactionRow,
  AuditLogRow,
  AuditLogSummaryRow,
  ListingSummaryRow,
  ModerationDetailRow,
  ModerationHistoryRow,
  ModerationQueueRow,
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

/** `/admin/me` 返回的当前可用能力。 */
const ADMIN_CAPABILITIES: AdminCapability[] = [
  'USERS_READ',
  'LISTINGS_READ',
  'OVERVIEW_READ',
  'AUDIT_LOGS_READ',
  'MODERATION_READ',
  'MODERATION_WRITE',
  'TRANSACTIONS_READ',
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

export type AdminModerationQueueListQuery = { cursor?: string; limit: number }
/** 审核记录检索参数（#73 治理半场 PR4）。日期字符串在这里转 Date，非法值由契约层先拦。 */
export type AdminModerationRecordsListQuery = {
  decision?: string
  listingId?: string
  q?: string
  createdFrom?: string
  createdTo?: string
  cursor?: string
  limit: number
}
export type AdminTransactionListQuery = {
  q?: string
  status?: string
  buyerId?: string
  sellerId?: string
  listingId?: string
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
  listModerationQueue(query: AdminModerationQueueListQuery): Promise<AdminModerationQueue>
  /** 审核记录检索（#73 治理半场 PR4）：已离开 REVIEW 队列的历史，可带筛选与游标。 */
  listModerationRecords(query: AdminModerationRecordsListQuery): Promise<AdminModerationRecords>
  getModerationDetail(recordId: string): Promise<AdminModerationDetail>
  decideModeration(input: {
    recordId: string
    actorUserId: string
    decision: 'ALLOW' | 'BLOCK'
    reason: string
    requestId: string
  }): Promise<AdminModerationDetail>
  listAdminTransactions(query: AdminTransactionListQuery): Promise<AdminTransactionPage>
}

function adminMeOf(me: Me): { admin: AdminMe; capabilities: AdminCapability[] } {
  return AdminMeResponseSchema.parse({
    admin: { ...me, role: 'ADMIN' },
    capabilities: ADMIN_CAPABILITIES,
  })
}

function toUserSummary(row: UserSummaryRow) {
  return AdminUserSummaryPageSchema.shape.items.element.safeParse({
    id: encodePublicId(PUBLIC_ID_PREFIX.user, row.id),
    // #86：微信用户没有学号 → null（端上显示占位），不能把 null 喂给 maskStudentNo。
    studentNoMasked: row.studentNo === null ? null : maskStudentNo(row.studentNo),
    nickname: row.nickname,
    authStatus: row.authStatus,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
    listingCount: row.listingCount,
    lastActivityAt: row.lastActivityAt?.toISOString() ?? null,
  })
}

function toListingSummary(row: ListingSummaryRow, storage: MediaStorage) {
  return AdminListingSummaryPageSchema.shape.items.element.safeParse({
    id: encodePublicId(PUBLIC_ID_PREFIX.listing, row.id),
    title: row.title,
    priceCents: row.priceCents,
    category: row.category,
    condition: row.condition,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    coverUrl: row.coverObjectKey ? storage.publicUrl(row.coverObjectKey) : null,
    seller: {
      id: encodePublicId(PUBLIC_ID_PREFIX.user, row.sellerId),
      nickname: row.sellerNickname,
    },
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
  prefix: PublicIdPrefix,
): { items: unknown[]; nextCursor: string | null } {
  const hasMore = rows.length > limit
  const items = rows.slice(0, limit)
  const last = items[items.length - 1]
  return {
    items: items.map((row) => pick(row)).filter((item) => item !== null),
    nextCursor: hasMore && last ? encodeCursor(last.createdAtCursor, last.id, prefix) : null,
  }
}

function toModerationRecord(row: ModerationDetailRow['record']) {
  return AdminModerationRecordSchema.parse({
    id: encodePublicId(PUBLIC_ID_PREFIX.moderationRecord, row.id),
    listingId: row.listingId ? encodePublicId(PUBLIC_ID_PREFIX.listing, row.listingId) : null,
    sellerId: encodePublicId(PUBLIC_ID_PREFIX.user, row.sellerId),
    action: row.action,
    titleSnapshot: row.titleSnapshot,
    descriptionSnapshot: row.descriptionSnapshot,
    decision: row.decision,
    matchedRules: row.matchedRules,
    matchedTermsMasked: row.matchedTermsMasked,
    ruleVersion: row.ruleVersion,
    createdAt: row.createdAt.toISOString(),
  })
}

function toModerationItem(row: ModerationQueueRow | ModerationHistoryRow | ModerationDetailRow) {
  const item = {
    record: toModerationRecord(row.record),
    listing: row.listing
      ? {
          id: encodePublicId(PUBLIC_ID_PREFIX.listing, row.listing.id),
          title: row.listing.title,
          description: row.listing.description,
          status: row.listing.status,
          moderationStatus: row.listing.moderationStatus,
          moderationReason: row.listing.moderationReason,
          createdAt: row.listing.createdAt.toISOString(),
        }
      : null,
    seller: {
      ...row.seller,
      id: encodePublicId(PUBLIC_ID_PREFIX.user, row.seller.id),
    },
  }
  return item
}

function moderationDetailOf(row: ModerationDetailRow) {
  const machine = row.record.action !== 'MANUAL_DECISION' ? row.record : null
  return AdminModerationDetailSchema.parse({
    item: toModerationItem(row),
    history: row.history.map(toModerationRecord),
    machineDecision: machine?.decision ?? null,
    humanDecision: row.humanDecision
      ? {
          decision: row.humanDecision.decision,
          reason: row.humanDecision.reason,
          actor: row.humanDecision.actorId
            ? {
                id: encodePublicId(PUBLIC_ID_PREFIX.user, row.humanDecision.actorId),
                nickname: row.humanDecision.actorNickname ?? '未知管理员',
              }
            : null,
          decidedAt: row.humanDecision.decidedAt.toISOString(),
        }
      : null,
  })
}

function toAdminTransaction(row: AdminTransactionRow) {
  return {
    id: encodePublicId(PUBLIC_ID_PREFIX.transaction, row.id),
    listingId: encodePublicId(PUBLIC_ID_PREFIX.listing, row.listingId),
    listingTitle: row.listingTitle,
    buyer: {
      id: encodePublicId(PUBLIC_ID_PREFIX.user, row.buyerId),
      nickname: row.buyerNickname,
    },
    seller: {
      id: encodePublicId(PUBLIC_ID_PREFIX.user, row.sellerId),
      nickname: row.sellerNickname,
    },
    amountCents: row.amountCents,
    status: row.status,
    buyerConfirmedAt: row.buyerConfirmedAt?.toISOString() ?? null,
    sellerConfirmedAt: row.sellerConfirmedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
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
      const cursor = query.cursor ? decodeCursor(query.cursor, PUBLIC_ID_PREFIX.user) : null
      if (query.cursor && !cursor) throw invalidCursor()

      const rows = await store.listUsers({
        q: query.q,
        authStatus: query.authStatus,
        role: query.role,
        cursor,
        limit: query.limit,
      })

      const page = pageOf(
        rows,
        query.limit,
        (row) => toUserSummary(row).data ?? null,
        PUBLIC_ID_PREFIX.user,
      )
      return AdminUserSummaryPageSchema.parse(page)
    },

    async getUserDetail(userId) {
      const summary = await store.findUserSummary(userId)
      if (!summary) throw new AdminError('ADMIN_NOT_FOUND', 404, '用户不存在')

      const [listingStats, recentAuditLogs, activeRestrictions] = await Promise.all([
        store.listingStatusCounts(userId),
        store.recentAuditLogs('USER', userId, 10),
        store.listActiveRestrictions(userId),
      ])

      const user = toUserSummary(summary)
      if (!user.success) {
        console.error('[admin] 用户详情无法映射为契约', summary.id, user.error.message)
        throw new AdminError('ADMIN_NOT_FOUND', 404, '用户不存在')
      }

      return AdminUserDetailSchema.parse({
        user: user.data,
        listingStats,
        // store 返回 Date 对象，契约要 ISO 字符串（z.iso.datetime()）。漏了这层转换，
        // 用户一旦有生效中的限制，parse 抛的 ZodError 不是 AdminError，会一路逃到
        // app.onError 变成 500——「契约字段存在的原因」恰恰是这个场景（对抗审查 F3）。
        activeRestrictions: activeRestrictions.map((restriction) => ({
          ...restriction,
          expiresAt: restriction.expiresAt?.toISOString() ?? null,
          createdAt: restriction.createdAt.toISOString(),
        })),
        recentAuditLogs: recentAuditLogs.map(toAuditLogSummary),
      })
    },

    async listListings(query) {
      const cursor = query.cursor ? decodeCursor(query.cursor, PUBLIC_ID_PREFIX.listing) : null
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

      const page = pageOf(
        rows,
        query.limit,
        (row) => toListingSummary(row, storage).data ?? null,
        PUBLIC_ID_PREFIX.listing,
      )
      return AdminListingSummaryPageSchema.parse(page)
    },

    async getListingDetail(listingId) {
      const found = await store.findListingDetail(listingId)
      if (!found) throw new AdminError('ADMIN_NOT_FOUND', 404, '商品不存在')

      const { listing, images } = found
      const detail = {
        id: encodePublicId(PUBLIC_ID_PREFIX.listing, listing.id),
        title: listing.title,
        description: listing.description,
        priceCents: listing.priceCents,
        category: listing.category,
        condition: listing.condition,
        status: listing.status,
        moderationStatus: listing.moderationStatus,
        governanceDelistedAt: listing.governanceDelistedAt
          ? listing.governanceDelistedAt.toISOString()
          : null,
        urgent: listing.urgent,
        negotiable: listing.negotiable,
        free: listing.free,
        createdAt: listing.createdAt.toISOString(),
        updatedAt: listing.updatedAt.toISOString(),
        images: images.map((image) => ({
          url: storage.publicUrl(image.objectKey),
          sortOrder: image.sortOrder,
        })),
        seller: {
          ...listing.seller,
          id: encodePublicId(PUBLIC_ID_PREFIX.user, listing.seller.id),
        },
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
      const cursor = query.cursor ? decodeCursor(query.cursor, PUBLIC_ID_PREFIX.auditLog) : null
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

      const page = pageOf(
        rows,
        query.limit,
        (row) => toAuditLogEntry(row).data ?? null,
        PUBLIC_ID_PREFIX.auditLog,
      )
      return AdminAuditLogPageSchema.parse(page)
    },

    async listModerationQueue(query) {
      const cursor = query.cursor
        ? decodeCursor(query.cursor, PUBLIC_ID_PREFIX.moderationRecord)
        : null
      if (query.cursor && !cursor) throw invalidCursor()
      const rows = await store.listModerationQueue({ cursor, limit: query.limit })
      const page = pageOf(
        rows,
        query.limit,
        (row) => {
          const item = toModerationItem(row)
          return AdminModerationQueueSchema.shape.items.element.parse(item)
        },
        PUBLIC_ID_PREFIX.moderationRecord,
      )
      return AdminModerationQueueSchema.parse(page)
    },

    async listModerationRecords(query) {
      const cursor = query.cursor
        ? decodeCursor(query.cursor, PUBLIC_ID_PREFIX.moderationRecord)
        : null
      if (query.cursor && !cursor) throw invalidCursor()
      const rows = await store.listModerationRecords({
        decision: query.decision,
        listingId: query.listingId,
        q: query.q,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
        cursor,
        limit: query.limit,
      })
      const page = pageOf(
        rows,
        query.limit,
        (row) => {
          const item = toModerationItem(row)
          return AdminModerationRecordsSchema.shape.items.element.parse(item)
        },
        PUBLIC_ID_PREFIX.moderationRecord,
      )
      return AdminModerationRecordsSchema.parse(page)
    },

    async getModerationDetail(recordId) {
      const row = await store.getModerationDetail(recordId)
      if (!row) throw new AdminError('ADMIN_NOT_FOUND', 404, '审核记录不存在')
      return moderationDetailOf(row)
    },

    async decideModeration(input) {
      const result = await store.decideModeration(input)
      if (result === 'not-found') throw new AdminError('ADMIN_NOT_FOUND', 404, '审核记录不存在')
      if (result === 'conflict')
        throw new AdminError('MODERATION_CONFLICT', 409, '审核记录已处理或已过期')
      if (result === 'idempotency-conflict') {
        throw new AdminError('MODERATION_CONFLICT', 409, 'Idempotency-Key 已用于其它审核决定')
      }
      const row = await store.getModerationDetail(input.recordId)
      if (!row) throw new AdminError('ADMIN_NOT_FOUND', 404, '审核记录不存在')
      return moderationDetailOf(row)
    },

    async listAdminTransactions(query) {
      const cursor = query.cursor ? decodeCursor(query.cursor, PUBLIC_ID_PREFIX.transaction) : null
      if (query.cursor && !cursor) throw invalidCursor()
      const rows = await store.listAdminTransactions({
        q: query.q,
        status: query.status,
        buyerId: query.buyerId,
        sellerId: query.sellerId,
        listingId: query.listingId,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
        cursor,
        limit: query.limit,
      })
      const page = pageOf(
        rows,
        query.limit,
        (row) => toAdminTransaction(row),
        PUBLIC_ID_PREFIX.transaction,
      )
      return AdminTransactionPageSchema.parse(page)
    },
  }
}

function invalidCursor(): AdminError {
  return new AdminError('VALIDATION_FAILED', 422, 'cursor 无效')
}
