import {
  AdminReportDetailSchema,
  type AdminReportHandleInput,
  type AdminReportItem,
  AdminReportItemSchema,
  type AdminReportListResponse,
  AdminReportListResponseSchema,
  type AdminReportQueueQuery,
  type ReportCreateResponse,
  ReportCreateResponseSchema,
  type ReportErrorCode,
  type ReportHandleResult,
  type ReportListResponse,
  ReportListResponseSchema,
  type ReportMineQuery,
  ReportSchema,
  type ReportTargetType,
} from '@fish/contracts/reports/schema'
import type { SystemErrorCode } from '@fish/contracts/system/error'
import { decodeCursor, encodeCursor } from '../admin/cursor'
import type { AdminReportRow, ReportRow, ReportStore } from './store'

/**
 * Reports service（#73 治理半场，设计 §6）：权限校验之后 + 数据层之前的业务编排。
 *
 * - 与 admin service 同一姿态：只从 store 产出的行构造 DTO，DTO 一律过契约 zod。
 * - **治理动作不在这里**：处理举报只写结果与原因（grill Q9：处理 ≠ 处罚）。
 *   下架 / 恢复 / 限制 / 封禁是独立的 Admin 端点，通过 `sourceReportId` 回链本举报。
 */
/**
 * 举报 service 的业务异常。
 *
 * `code` 除了 `ReportErrorCodeSchema` 里的举报域错误码，还允许 system 域的
 * `VALIDATION_FAILED`（非法 cursor）：与 listings 域同款取舍——各 domain 只声明
 * **新增**的错误码，通用码复用 `system/error.ts`，不自己再抄一份（设计 §9）。
 */
export class ReportServiceError extends Error {
  constructor(
    readonly code: ReportErrorCode | SystemErrorCode,
    readonly status: 404 | 409 | 422,
    message: string,
  ) {
    super(message)
    this.name = 'ReportServiceError'
  }
}

/** 目标行已不存在时给管理员的兜底展示名（契约要求 label 非空）。 */
const MISSING_TARGET_LABEL = '目标已删除'

/** 同目标未决举报最多带出这么多条（详情页一次看完，不分页）。 */
const RELATED_PENDING_LIMIT = 20

function invalidCursor(): ReportServiceError {
  return new ReportServiceError('VALIDATION_FAILED', 422, 'cursor 无效')
}

function toReportDto(row: ReportRow) {
  return ReportSchema.parse({
    id: row.id,
    targetType: row.targetType,
    targetId: row.targetId,
    reason: row.reason,
    detailText: row.detailText,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    handledAt: row.handledAt ? row.handledAt.toISOString() : null,
  })
}

function toAdminReportItem(row: AdminReportRow): AdminReportItem {
  return AdminReportItemSchema.parse({
    report: {
      id: row.report.id,
      targetType: row.report.targetType,
      targetId: row.report.targetId,
      reason: row.report.reason,
      detailText: row.report.detailText,
      status: row.report.status,
      createdAt: row.report.createdAt.toISOString(),
      handledAt: row.report.handledAt ? row.report.handledAt.toISOString() : null,
      handlingReason: row.report.handlingReason,
      handledBy: row.handler,
    },
    reporter: row.reporter,
    target: {
      targetType: row.target.targetType,
      targetId: row.target.targetId,
      label: row.target.label ?? MISSING_TARGET_LABEL,
      listingStatus: row.target.listingStatus,
      moderationStatus: row.target.moderationStatus,
    },
    reportCount: row.reportCount,
  })
}

export interface ReportService {
  createReport(
    reporterId: string,
    input: {
      targetType: ReportTargetType
      targetId: string
      reason: string
      detailText: string | null
    },
  ): Promise<ReportCreateResponse>
  listMine(reporterId: string, query: ReportMineQuery): Promise<ReportListResponse>
  listAdminReports(query: AdminReportQueueQuery): Promise<AdminReportListResponse>
  getAdminReport(reportId: string): Promise<ReturnType<typeof AdminReportDetailSchema.parse>>
  handleReport(input: {
    reportId: string
    actorUserId: string
    result: ReportHandleResult
    reason: AdminReportHandleInput['reason']
  }): Promise<void>
}

export function createReportService(store: ReportStore): ReportService {
  return {
    async createReport(reporterId, input) {
      // 举报自己（USER 目标 = 本人）没有治理意义，且能被用来刷举报单：422。
      if (input.targetType === 'USER' && input.targetId === reporterId) {
        throw new ReportServiceError('REPORT_SELF_TARGET', 422, '不能举报自己')
      }
      // 目标必须真实存在：多态目标没有外键，服务端必须在创建时校验，
      // 否则可以拿任意 uuid 造出永远处理不完的举报单。
      const target = await store.findTargetSummary(input.targetType, input.targetId)
      if (!target) {
        throw new ReportServiceError('REPORT_TARGET_NOT_FOUND', 404, '举报目标不存在')
      }
      const { row, created } = await store.createReport({
        reporterId,
        targetType: input.targetType,
        targetId: input.targetId,
        reason: input.reason as Parameters<ReportStore['createReport']>[0]['reason'],
        detailText: input.detailText,
      })
      return ReportCreateResponseSchema.parse({ report: toReportDto(row), created })
    },

    async listMine(reporterId, query) {
      const cursor = query.cursor ? decodeCursor(query.cursor) : null
      if (query.cursor && !cursor) throw invalidCursor()

      const rows = await store.listMine(reporterId, { cursor, limit: query.limit + 1 })
      const hasMore = rows.length > query.limit
      const items = rows.slice(0, query.limit)
      const last = items[items.length - 1]
      return ReportListResponseSchema.parse({
        items: items.map(toReportDto),
        nextCursor: hasMore && last ? encodeCursor(last.createdAtCursor, last.id) : null,
      })
    },

    async listAdminReports(query) {
      const cursor = query.cursor ? decodeCursor(query.cursor) : null
      if (query.cursor && !cursor) throw invalidCursor()

      const rows = await store.listAdminReports({
        status: query.status,
        targetType: query.targetType,
        reason: query.reason,
        cursor,
        limit: query.limit + 1,
      })
      const hasMore = rows.length > query.limit
      const items = rows.slice(0, query.limit)
      const last = items[items.length - 1]
      return AdminReportListResponseSchema.parse({
        items: items.map(toAdminReportItem),
        nextCursor:
          hasMore && last ? encodeCursor(last.report.createdAtCursor, last.report.id) : null,
      })
    },

    async getAdminReport(reportId) {
      const row = await store.findAdminReport(reportId)
      if (!row) throw new ReportServiceError('REPORT_NOT_FOUND', 404, '举报不存在')
      const related = await store.listRelatedPending(
        row.target.targetType,
        row.target.targetId,
        row.report.id,
        RELATED_PENDING_LIMIT,
      )
      return AdminReportDetailSchema.parse({
        item: toAdminReportItem(row),
        related: related.map(toReportDto),
      })
    },

    async handleReport(input) {
      const result = await store.handleReport({
        reportId: input.reportId,
        actorUserId: input.actorUserId,
        result: input.result,
        reason: input.reason,
      })
      if (result === 'not-found') {
        throw new ReportServiceError('REPORT_NOT_FOUND', 404, '举报不存在')
      }
      if (result === 'conflict') {
        // 两个管理员同时处理：后到的那一个拿到确定的结果，不抛原始异常、不猜状态。
        throw new ReportServiceError('REPORT_CONFLICT', 409, '该举报已被处理')
      }
    },
  }
}
