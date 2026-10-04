import {
  RECOMMENDATION_METRICS_WINDOW_MS,
  type RecommendationMetrics,
  RecommendationMetricsSchema,
  type RecommendationMetricsWindow,
} from '@fish/contracts/admin/recommendation-metrics'
import type {
  AdminAuditAction,
  AdminAuditLogPage,
  AdminAuditTargetType,
  AdminCapability,
} from '@fish/contracts/admin/schema'
import {
  AdminAuditLogEntrySchema,
  AdminAuditLogPageSchema,
  AdminAuditTargetTypeSchema,
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
import {
  decodePublicId,
  encodePublicId,
  PUBLIC_ID_PREFIX,
  type PublicIdPrefix,
} from '@fish/shared/public-id'
import { createDefaultLatencyRecorder, type LatencyRecorder } from '../../observability/latency'
import {
  NO_RECOMMENDATION_PROCESS_METRICS,
  type RecommendationProcessMetrics,
} from '../../observability/recommendation-metrics'
import type { MediaStorage } from '../uploads/storage'
import {
  auditTargetInfo,
  decodeAuditFilter,
  projectAuditId,
  projectAuditSnapshot,
} from './audit-public-id'
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

/**
 * 推荐埋点的**进程内**计数（#323 R6 §6.3 / 决策 D5、N2）。
 *
 * 形状与实现都在 `apps/api/src/observability/recommendation-metrics.ts`（`app.ts` 建实例，
 * 推荐模块写、admin 模块读）。这里 re-export 是为了让"admin 读到的形状"只有一个定义——
 * 端口与实现分家会漂移成"加了计数点但没人读"或"读了永远为 0 的字段"。
 */
export type { RecommendationProcessMetrics } from '../../observability/recommendation-metrics'

/**
 * 没有接上计数器时的默认值（全 0）。
 *
 * **不是"没有失败"，而是"还没接上计数"**：`eventWriteFailureRate` 因此是 `null`（0/0 口径）。
 * 生产装配（`app.ts`）永远注入真实计数器；这个常量只服务于不关心计数的测试与可选依赖的缺省。
 */
const NO_PROCESS_METRICS: RecommendationProcessMetrics = NO_RECOMMENDATION_PROCESS_METRICS

/** 分母 0 → `null`（"这个窗口里没有可算的东西"），而不是 0（"差到 0"）。 */
function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator
}

export interface AdminService {
  getMe(me: Me): Promise<{ admin: AdminMe; capabilities: AdminCapability[] }>
  listUsers(query: AdminUserListQuery): Promise<AdminUserSummaryPage>
  getUserDetail(userId: string): Promise<AdminUserDetail>
  listListings(query: AdminListingListQuery): Promise<AdminListingSummaryPage>
  getListingDetail(listingId: string): Promise<AdminListingDetail>
  getOverview(): Promise<AdminOverview>
  /**
   * 推荐漏斗 / guardrail / 延迟（#323 R6）：`window` 档位在这里换算成左闭右开区间，
   * 数据库侧只认 `since` / `until`。
   */
  getRecommendationMetrics(query: {
    window: RecommendationMetricsWindow
  }): Promise<RecommendationMetrics>
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

type ResolveLegacyAuditId = AdminStore['resolveLegacyAuditId']

async function toAuditLogEntry(row: AuditLogRow, resolveLegacy: ResolveLegacyAuditId) {
  const targetType = AdminAuditTargetTypeSchema.safeParse(row.targetType)
  if (!targetType.success) return AdminAuditLogEntrySchema.safeParse(null)
  const { prefix, table } = auditTargetInfo(targetType.data)
  return AdminAuditLogEntrySchema.safeParse({
    id: encodePublicId(PUBLIC_ID_PREFIX.auditLog, row.id),
    actor:
      row.actorUserId && row.actorNickname != null
        ? {
            id: encodePublicId(PUBLIC_ID_PREFIX.user, row.actorUserId),
            nickname: row.actorNickname,
          }
        : null,
    action: row.action,
    targetType: targetType.data,
    targetId: await projectAuditId(prefix, table, row.targetId, resolveLegacy),
    before: await projectAuditSnapshot(row.before ?? null, resolveLegacy),
    after: await projectAuditSnapshot(row.after ?? null, resolveLegacy),
    reason: row.reason,
    requestId: row.requestId,
    createdAt: row.createdAt.toISOString(),
  })
}

async function toAuditLogSummary(row: AuditLogSummaryRow, resolveLegacy: ResolveLegacyAuditId) {
  const targetType = AdminAuditTargetTypeSchema.parse(row.targetType)
  const { prefix, table } = auditTargetInfo(targetType)
  return {
    id: encodePublicId(PUBLIC_ID_PREFIX.auditLog, row.id),
    action: row.action,
    targetType,
    targetId: await projectAuditId(prefix, table, row.targetId, resolveLegacy),
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
  latency,
  recommendationProcessMetrics,
  clock,
}: {
  store: AdminStore
  storage: MediaStorage
  /**
   * 进程内延迟采样（`apps/api/src/observability/latency.ts`）：由 `app.ts` 创建**一个**实例，
   * 同时交给推荐 router（写）与这里（读）。缺省时自建一个空实例（测试与未接线场景下
   * `latency` 三项齐全但 `count = 0`）。
   */
  latency?: LatencyRecorder
  /**
   * 推荐埋点的进程内计数（#323 R6 §6.3）：**传读取函数而不是快照值**——这些数字随请求变化，
   * 启动时取一份快照会让 admin 端点永远返回 0（正是"读了一个永远不变的字段"这种 bug）。
   * 缺省时用全 0 常量（见 `NO_PROCESS_METRICS`）。
   */
  recommendationProcessMetrics?: () => RecommendationProcessMetrics
  /** 生成时刻与窗口末端。测试注入固定时钟，避免断言依赖 `now()`。 */
  clock?: () => Date
}): AdminService {
  const latencyRecorder = latency ?? createDefaultLatencyRecorder(clock)
  const readProcessMetrics = recommendationProcessMetrics ?? (() => NO_PROCESS_METRICS)
  const now = clock ?? (() => new Date())

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
          id: encodePublicId(PUBLIC_ID_PREFIX.userRestriction, restriction.id),
          expiresAt: restriction.expiresAt?.toISOString() ?? null,
          createdAt: restriction.createdAt.toISOString(),
        })),
        recentAuditLogs: await Promise.all(
          recentAuditLogs.map((row) => toAuditLogSummary(row, store.resolveLegacyAuditId)),
        ),
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
        recentAuditLogs: await Promise.all(
          (await store.recentAuditLogs('LISTING', listingId, 10)).map((row) =>
            toAuditLogSummary(row, store.resolveLegacyAuditId),
          ),
        ),
      }

      return AdminListingDetailSchema.parse(detail)
    },

    async getOverview() {
      return AdminOverviewSchema.parse(await store.getOverview())
    },

    async getRecommendationMetrics(query) {
      // 每次请求现读一份进程内计数：它是"自本进程启动以来"的累计值，不是窗口值（契约注释已写明）。
      const processMetrics = readProcessMetrics()
      const until = now()
      // 左闭右开：与 store 的 SQL（`>= since AND < until`）以及其它时间筛选口径一致，
      // 避免落在边界同一毫秒的行被两个相邻窗口重复计入。
      const since = new Date(until.getTime() - RECOMMENDATION_METRICS_WINDOW_MS[query.window])
      const row = await store.getRecommendationMetrics({ since, until })

      // 缺席 = 该类型在窗口内 0 条（SQL 是 GROUP BY，不会为 0 行补类型）。
      const countOf = (eventType: string) => row.attributedEventCounts.get(eventType) ?? 0
      const impressions = countOf('IMPRESSION')
      const detailViews = countOf('DETAIL_VIEW')
      const favorites = countOf('FAVORITE')
      const chats = countOf('CHAT_START')
      const transactions = countOf('TRANSACTION_START')
      const purchases = countOf('PURCHASE')

      return RecommendationMetricsSchema.parse({
        window: query.window,
        generatedAt: until.toISOString(),
        processStartedAt: latencyRecorder.startedAt.toISOString(),
        funnel: {
          feedRequests: row.feedRequests,
          degradedFeedRequests: row.degradedFeedRequests,
          impressions,
          detailViews,
          favorites,
          chats,
          transactions,
          purchases,
          impressionToDetailRate: ratio(detailViews, impressions),
          detailToFavoriteRate: ratio(favorites, detailViews),
          detailToChatRate: ratio(chats, detailViews),
          chatToTransactionRate: ratio(transactions, chats),
          transactionToPurchaseRate: ratio(purchases, transactions),
        },
        // 生命周期三项（M8）：store 已按契约 `RecommendationLifecycleSchema` 的结构返回
        // （分位口径与离线评估 job 一致，空样本 `{ count: 0, median: null, p90: null }`），这里只透传。
        lifecycle: row.lifecycle,
        guardrails: {
          emptyRankedFeedRate: ratio(row.emptyRankedFeedRequests, row.rankedFeedRequests),
          // 重复曝光 = 快照行里"同一个身份看过同一个商品"之外的份额（与离线评估 §5.4 同口径）。
          repeatedExposureRate: ratio(
            row.snapshotItems - row.snapshotDistinctPairs,
            row.snapshotItems,
          ),
          topSellerExposureShare: ratio(row.topSellerExposures, row.attributedImpressions),
          top10SellerExposureShare: ratio(row.top10SellerExposures, row.attributedImpressions),
          staleListingExposureRate: ratio(row.staleListingExposures, row.attributedImpressions),
          eventWriteFailureRate: ratio(
            processMetrics.eventWriteFailures,
            processMetrics.eventWriteAttempts,
          ),
          rateLimitedRequests: processMetrics.rateLimitedRequests,
          eventRejectionReasons: { ...processMetrics.eventRejectionReasons },
        },
        latency: latencyRecorder.snapshot(),
      })
    },

    async listAuditLogs(query) {
      const cursor = query.cursor ? decodeCursor(query.cursor, PUBLIC_ID_PREFIX.auditLog) : null
      if (query.cursor && !cursor) throw invalidCursor()
      const targetId = query.targetId
        ? decodeAuditFilter(query.targetType, query.targetId)
        : undefined
      if (query.targetId && !targetId) {
        throw new AdminError('VALIDATION_FAILED', 422, '审计目标 ID 与资源类型不匹配')
      }

      const rows = await store.listAuditLogs({
        actorId: query.actorId ? decodePublicId(PUBLIC_ID_PREFIX.user, query.actorId) : undefined,
        action: query.action,
        targetType: query.targetType,
        targetId: targetId?.id,
        targetTable: targetId?.table,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
        cursor,
        limit: query.limit,
      })

      const projected = await Promise.all(
        rows.map(async (row) => ({
          ...row,
          entry: (await toAuditLogEntry(row, store.resolveLegacyAuditId)).data ?? null,
        })),
      )
      const page = pageOf(projected, query.limit, (row) => row.entry, PUBLIC_ID_PREFIX.auditLog)
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
      // #286：图片结算拒绝本次决策（图已被人工阻断 / 私有对象或台账缺失），事务已回滚。
      if (result === 'media-blocked') {
        throw new AdminError('MODERATION_CONFLICT', 409, '该商品的图片已被人工阻断，不能放行')
      }
      if (result === 'media-settlement-failed') {
        throw new AdminError('MODERATION_CONFLICT', 409, '图片结算失败，本次决策未生效，请重试')
      }
      // 台账行 / 私有对象缺失是持久状态：重试不会成功，要人工排查，所以与可重试的上一条分开报。
      if (result === 'media-settlement-data-missing') {
        throw new AdminError(
          'MODERATION_CONFLICT',
          409,
          '该商品的审核图片台账或对象缺失，无法放行，请人工核查',
        )
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
