import type { AdminAuditAction, AdminAuditTargetType } from '@fish/contracts/admin/schema'
import type { ReportReason, ReportStatus, ReportTargetType } from '@fish/contracts/reports/schema'
import type { Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { jsonParam } from '@fish/db/json'
import { adminAuditLogs } from '@fish/db/schema/admin'
import { sql } from 'drizzle-orm'
import { createdAtCursorText, cursorCondition } from '../admin/cursor'

/**
 * Reports store（#73 治理半场）：举报的全部 SQL。
 *
 * 与 admin store 的分工：`decideModeration` 那种「业务 + 审计同事务」的写法在这里延续——
 * `handleReport` 自己开事务，业务 UPDATE 与审计 INSERT 在同一事务里，条件更新
 * `WHERE status = 'PENDING'` 处理两个管理员同时处理。
 */

export type ReportDbTransaction = Parameters<Parameters<Db['transaction']>[0]>[0]

/** 一条举报的持久化形态（含仅管理端可见的处理字段）。 */
export type ReportRow = {
  id: string
  reporterId: string
  targetType: string
  targetId: string
  reason: string
  detailText: string | null
  status: string
  createdAt: Date
  handledAt: Date | null
  handlingReason: string | null
  handledBy: string | null
  /** 微秒精度游标文本（`to_char` 产出，见 admin/cursor.ts）。 */
  createdAtCursor: string
}

/** 被举报目标的摘要。`label` 为 null 表示目标不存在。 */
export type TargetSummaryRow = {
  targetType: string
  targetId: string
  label: string | null
  listingStatus: string | null
  moderationStatus: string | null
}

/** 举报人摘要（管理端展示用，不返回敏感字段）。 */
export type ReporterSummaryRow = {
  id: string
  nickname: string
}

/** Admin 队列项：举报 + 举报人 + 处理人 + 目标摘要 + 同目标举报数。 */
export type AdminReportRow = {
  report: ReportRow
  reporter: ReporterSummaryRow
  /** 处理人摘要；未处理为 null（`handled_by` 只是 id，队列要展示昵称）。 */
  handler: ReporterSummaryRow | null
  target: TargetSummaryRow
  reportCount: number
}

export type ListMineCriteria = {
  cursor: { createdAt: string; id: string } | null
  limit: number
}

export type ListAdminReportsCriteria = {
  status: ReportStatus | undefined
  targetType: ReportTargetType | undefined
  reason: ReportReason | undefined
  cursor: { createdAt: string; id: string } | null
  limit: number
}

export type HandleReportInput = {
  reportId: string
  actorUserId: string
  result: ReportStatus
  reason: string
}

export interface ReportStore {
  /** 目标是否存在 + 展示摘要。目标不存在返回 null（服务端据此拒绝举报）。 */
  findTargetSummary(
    targetType: ReportTargetType,
    targetId: string,
  ): Promise<TargetSummaryRow | null>
  /**
   * 插入举报。命中部分唯一索引（同一举报人 + 同一目标 + 已有未决）时不新增，
   * 直接返回已存在的那条（`created: false`）。
   */
  createReport(input: {
    reporterId: string
    targetType: ReportTargetType
    targetId: string
    reason: ReportReason
    detailText: string | null
  }): Promise<{ row: ReportRow; created: boolean }>
  listMine(reporterId: string, criteria: ListMineCriteria): Promise<ReportRow[]>
  listAdminReports(criteria: ListAdminReportsCriteria): Promise<AdminReportRow[]>
  findAdminReport(reportId: string): Promise<AdminReportRow | null>
  /** 同目标的其它未决举报（详情页聚合多个举报人）。 */
  listRelatedPending(
    targetType: string,
    targetId: string,
    excludeReportId: string,
    limit: number,
  ): Promise<ReportRow[]>
  /** 处理举报：业务 UPDATE 与审计写入同事务。 */
  handleReport(input: HandleReportInput): Promise<'applied' | 'not-found' | 'conflict'>
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}

const reportSelectSql = sql`
  r.id AS id, r.reporter_id AS reporter_id, r.target_type AS target_type,
  r.target_id AS target_id, r.reason AS reason, r.detail_text AS detail_text,
  r.status AS status, r.created_at AS created_at, r.handled_at AS handled_at,
  r.handling_reason AS handling_reason, r.handled_by AS handled_by,
  ${createdAtCursorText(sql`r.created_at`)} AS created_at_cursor
`

function reportFromRow(row: Record<string, unknown>): ReportRow {
  return {
    id: String(row.id),
    reporterId: String(row.reporter_id),
    targetType: String(row.target_type),
    targetId: String(row.target_id),
    reason: String(row.reason),
    detailText: (row.detail_text as string | null) ?? null,
    status: String(row.status),
    createdAt: new Date(row.created_at as string | Date),
    handledAt: (row.handled_at as string | Date | null)
      ? new Date(row.handled_at as string | Date)
      : null,
    handlingReason: (row.handling_reason as string | null) ?? null,
    handledBy: (row.handled_by as string | null) ?? null,
    createdAtCursor: String(row.created_at_cursor),
  }
}

/**
 * 队列 / 详情共用的 SELECT：举报人 JOIN users，目标按 target_type 分别 LEFT JOIN
 * listings / users（多态目标不建外键，只能这样取展示名）。计数必须在独立的
 * reports 别名上计算：队列的状态、原因及游标过滤均不应缩小目标的全量举报数。
 */
const adminReportSelectSql = sql`
  ${reportSelectSql},
  (SELECT count(*)::int FROM reports all_reports
    WHERE all_reports.target_type = r.target_type AND all_reports.target_id = r.target_id)
    AS report_count,
  ru.id AS reporter_summary_id, ru.nickname AS reporter_nickname,
  hu.id AS handler_summary_id, hu.nickname AS handler_nickname,
  COALESCE(l.title, tu.nickname) AS target_label,
  l.status::text AS listing_status,
  l.moderation_status::text AS moderation_status
  FROM reports r
  JOIN users ru ON ru.id = r.reporter_id
  LEFT JOIN users hu ON hu.id = r.handled_by
  LEFT JOIN listings l ON r.target_type = 'LISTING' AND l.id = r.target_id
  LEFT JOIN users tu ON r.target_type = 'USER' AND tu.id = r.target_id
`

function adminReportFromRow(row: Record<string, unknown>): AdminReportRow {
  return {
    report: reportFromRow(row),
    reporter: { id: String(row.reporter_summary_id), nickname: String(row.reporter_nickname) },
    handler:
      row.handler_summary_id === null || row.handler_summary_id === undefined
        ? null
        : {
            id: String(row.handler_summary_id),
            nickname: String(row.handler_nickname),
          },
    target: {
      targetType: String(row.target_type),
      targetId: String(row.target_id),
      label: (row.target_label as string | null) ?? null,
      listingStatus: (row.listing_status as string | null) ?? null,
      moderationStatus: (row.moderation_status as string | null) ?? null,
    },
    reportCount: Number(row.report_count),
  }
}

export function createSqlReportStore(db: Db): ReportStore {
  return {
    async findTargetSummary(targetType, targetId) {
      // 多态目标：两段 SQL 分别查。用裸 SQL 而非 typed builder，与 admin store 取封面 /
      // 计数同口径（typed builder 的相关子查询在 bun-sql 下会静默算错）。
      const result =
        targetType === 'LISTING'
          ? await db.execute(sql`
              SELECT ${targetId}::uuid AS target_id,
                     title AS label,
                     status::text AS listing_status,
                     moderation_status::text AS moderation_status
              FROM listings WHERE id = ${targetId}
            `)
          : await db.execute(sql`
              SELECT ${targetId}::uuid AS target_id,
                     nickname AS label,
                     NULL::text AS listing_status,
                     NULL::text AS moderation_status
              FROM users WHERE id = ${targetId}
            `)
      const row = rowsOf(result)[0]
      if (!row) return null
      return {
        targetType,
        targetId,
        label: String(row.label),
        listingStatus: (row.listing_status as string | null) ?? null,
        moderationStatus: (row.moderation_status as string | null) ?? null,
      }
    },

    async createReport(input) {
      // ON CONFLICT DO NOTHING 命中部分唯一索引：并发重复提交不会双双插入，也不需要
      // 捕异常（异常路径在 bun-sql 下会污染连接池）。
      const inserted = await db.execute(sql`
        INSERT INTO reports (id, reporter_id, target_type, target_id, reason, detail_text)
        VALUES (${newId()}, ${input.reporterId}, ${input.targetType}::report_target_type,
                ${input.targetId}, ${input.reason}::report_reason, ${input.detailText})
        ON CONFLICT (reporter_id, target_type, target_id) WHERE status = 'PENDING'
        DO NOTHING
        RETURNING id, reporter_id, target_type::text AS target_type, target_id, reason,
                  detail_text, status::text AS status, created_at, handled_at,
                  handling_reason, handled_by,
                  ${createdAtCursorText(sql`reports.created_at`)} AS created_at_cursor
      `)
      const row = rowsOf(inserted)[0]
      if (row) return { row: reportFromRow(row), created: true }

      // 重复 INSERT 没插进去：说明已有一条未决举报。这里再 SELECT 一次把它原样交回。
      // 极端竞态：两次语句之间那条未决举报刚被处理掉（PENDING → HANDLED），此时
      // 唯一索引已不再挡住我们，直接重试 INSERT 就能落库——不能 500，用户确实还能举报。
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const existing = await db.execute(sql`
          SELECT id, reporter_id, target_type::text AS target_type, target_id, reason,
                 detail_text, status::text AS status, created_at, handled_at,
                 handling_reason, handled_by,
                 ${createdAtCursorText(sql`reports.created_at`)} AS created_at_cursor
          FROM reports
          WHERE reporter_id = ${input.reporterId}
            AND target_type = ${input.targetType}::report_target_type
            AND target_id = ${input.targetId}
            AND status = 'PENDING'
          LIMIT 1
        `)
        const existingRow = rowsOf(existing)[0]
        if (existingRow) return { row: reportFromRow(existingRow), created: false }
        if (attempt === 1) break

        const retry = await db.execute(sql`
          INSERT INTO reports (id, reporter_id, target_type, target_id, reason, detail_text)
          VALUES (${newId()}, ${input.reporterId}, ${input.targetType}::report_target_type,
                  ${input.targetId}, ${input.reason}::report_reason, ${input.detailText})
          ON CONFLICT (reporter_id, target_type, target_id) WHERE status = 'PENDING'
          DO NOTHING
          RETURNING id
        `)
        const retryRow = rowsOf(retry)[0]
        if (retryRow) {
          const reloaded = await db.execute(sql`
            SELECT id, reporter_id, target_type::text AS target_type, target_id, reason,
                   detail_text, status::text AS status, created_at, handled_at,
                   handling_reason, handled_by,
                   ${createdAtCursorText(sql`reports.created_at`)} AS created_at_cursor
            FROM reports WHERE id = ${String(retryRow.id)}
          `)
          const reloadedRow = rowsOf(reloaded)[0]
          if (reloadedRow) return { row: reportFromRow(reloadedRow), created: true }
        }
      }
      // 两次都没查到未决举报也没插进去：唯一索引被外部改坏时才会出现，宁可 500 也不返回假数据。
      throw new Error('举报重复但未找到未决举报（唯一索引异常）')
    },

    async listMine(reporterId, criteria) {
      const conditions = [sql`r.reporter_id = ${reporterId}`]
      if (criteria.cursor) {
        conditions.push(cursorCondition(sql`r.created_at`, sql`r.id`, criteria.cursor))
      }
      const result = await db.execute(sql`
        SELECT ${reportSelectSql}
        FROM reports r
        WHERE ${sql.join(conditions, sql` AND `)}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ${criteria.limit}
      `)
      return rowsOf(result).map(reportFromRow)
    },

    async listAdminReports(criteria) {
      const conditions: ReturnType<typeof sql>[] = []
      if (criteria.status) conditions.push(sql`r.status = ${criteria.status}::report_status`)
      if (criteria.targetType) {
        conditions.push(sql`r.target_type = ${criteria.targetType}::report_target_type`)
      }
      if (criteria.reason) conditions.push(sql`r.reason = ${criteria.reason}::report_reason`)
      if (criteria.cursor) {
        conditions.push(cursorCondition(sql`r.created_at`, sql`r.id`, criteria.cursor))
      }
      const where = conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``
      const result = await db.execute(sql`
        SELECT ${adminReportSelectSql}
        ${where}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ${criteria.limit}
      `)
      return rowsOf(result).map(adminReportFromRow)
    },

    async findAdminReport(reportId) {
      const result = await db.execute(sql`
        SELECT ${adminReportSelectSql}
        WHERE r.id = ${reportId}
        LIMIT 1
      `)
      const row = rowsOf(result)[0]
      return row ? adminReportFromRow(row) : null
    },

    async listRelatedPending(targetType, targetId, excludeReportId, limit) {
      const result = await db.execute(sql`
        SELECT ${reportSelectSql}
        FROM reports r
        WHERE r.target_type = ${targetType}::report_target_type
          AND r.target_id = ${targetId}
          AND r.status = 'PENDING'
          AND r.id <> ${excludeReportId}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ${limit}
      `)
      return rowsOf(result).map(reportFromRow)
    },

    async handleReport(input) {
      return db.transaction(async (tx) => {
        // 条件更新：只有仍 PENDING 的单子能被处理。另一个管理员已经处理过 → 0 行 →
        // 重读区分「不存在」与「已被处理」，给调用方确定的结果（不抛、不猜）。
        const updated = await tx.execute(sql`
          UPDATE reports
          SET status = ${input.result}::report_status,
              handled_by = ${input.actorUserId},
              handled_at = now(),
              handling_reason = ${input.reason},
              updated_at = now()
          WHERE id = ${input.reportId} AND status = 'PENDING'
          RETURNING id, reporter_id, target_type::text AS target_type, target_id, reason
        `)
        const updatedRow = rowsOf(updated)[0]
        if (!updatedRow) {
          const existing = await tx.execute(sql`
            SELECT id FROM reports WHERE id = ${input.reportId}
          `)
          return rowsOf(existing).length > 0 ? ('conflict' as const) : ('not-found' as const)
        }

        await tx.insert(adminAuditLogs).values({
          id: newId(),
          actorUserId: input.actorUserId,
          action: 'REPORT_DECISION' satisfies AdminAuditAction,
          targetType: 'REPORT' satisfies AdminAuditTargetType,
          targetId: input.reportId,
          before: jsonParam({ status: 'PENDING' }),
          after: jsonParam({
            status: input.result,
            targetType: String(updatedRow.target_type),
            targetId: String(updatedRow.target_id),
            reporterId: String(updatedRow.reporter_id),
          }),
          reason: input.reason,
        })
        return 'applied' as const
      })
    },
  }
}
