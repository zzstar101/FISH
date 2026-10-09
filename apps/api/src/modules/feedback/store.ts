import type { AdminAuditAction, AdminAuditTargetType } from '@fish/contracts/admin/schema'
import type {
  FeedbackHandleResult,
  FeedbackStatus,
  FeedbackType,
} from '@fish/contracts/feedback/schema'
import type { Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { jsonParam } from '@fish/db/json'
import { adminAuditLogs } from '@fish/db/schema/admin'
import { sql } from 'drizzle-orm'
import { createdAtCursorText, cursorCondition } from '../admin/cursor'

/**
 * Feedback store（#463）：意见反馈的全部 SQL。
 *
 * 与 reports store 同一写法：裸 SQL（typed builder 的相关子查询在 bun-sql 下会静默算错），
 * 处理动作「业务 UPDATE + 审计 INSERT」同事务，条件更新 `WHERE status = 'PENDING'`
 * 处理两个管理员同时处理。
 */

export type FeedbackRow = {
  id: string
  userId: string
  type: string
  content: string
  contact: string | null
  status: string
  reply: string | null
  handlingNote: string | null
  handledBy: string | null
  createdAt: Date
  handledAt: Date | null
  /** 微秒精度游标文本（`to_char` 产出，见 admin/cursor.ts）。 */
  createdAtCursor: string
}

export type FeedbackUserRow = { id: string; nickname: string }

export type AdminFeedbackRow = {
  feedback: FeedbackRow
  submitter: FeedbackUserRow
  handler: FeedbackUserRow | null
}

type Cursor = { createdAt: string; id: string } | null

export type CreateFeedbackOutcome =
  | { kind: 'created'; row: FeedbackRow }
  | { kind: 'replayed'; row: FeedbackRow }
  | { kind: 'rate-limited' }

export interface FeedbackStore {
  /**
   * 提交反馈。同一 `(userId, clientRequestId)` 已存在 → `replayed`（不计频控、不新增）；
   * 滚动 24 小时内已达 `dailyLimit` 条 → `rate-limited`。
   */
  createFeedback(input: {
    userId: string
    clientRequestId: string
    type: FeedbackType
    content: string
    contact: string | null
    dailyLimit: number
  }): Promise<CreateFeedbackOutcome>
  listMine(userId: string, criteria: { cursor: Cursor; limit: number }): Promise<FeedbackRow[]>
  listAdmin(criteria: {
    status: FeedbackStatus | undefined
    type: FeedbackType | undefined
    cursor: Cursor
    limit: number
  }): Promise<AdminFeedbackRow[]>
  findAdmin(feedbackId: string): Promise<AdminFeedbackRow | null>
  handleFeedback(input: {
    feedbackId: string
    actorUserId: string
    result: FeedbackHandleResult
    reply: string | null
    note: string
  }): Promise<'applied' | 'not-found' | 'conflict'>
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}

const nullableText = (value: unknown) => (value as string | null | undefined) ?? null
const nullableDate = (value: unknown) =>
  value === null || value === undefined ? null : new Date(value as string | Date)

const feedbackSelectSql = sql`
  f.id AS id, f.user_id AS user_id, f.type::text AS type, f.content AS content,
  f.contact AS contact, f.status::text AS status, f.reply AS reply,
  f.handling_note AS handling_note, f.handled_by AS handled_by,
  f.created_at AS created_at, f.handled_at AS handled_at,
  ${createdAtCursorText(sql`f.created_at`)} AS created_at_cursor
`

function feedbackFromRow(row: Record<string, unknown>): FeedbackRow {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    type: String(row.type),
    content: String(row.content),
    contact: nullableText(row.contact),
    status: String(row.status),
    reply: nullableText(row.reply),
    handlingNote: nullableText(row.handling_note),
    handledBy: nullableText(row.handled_by),
    createdAt: new Date(row.created_at as string | Date),
    handledAt: nullableDate(row.handled_at),
    createdAtCursor: String(row.created_at_cursor),
  }
}

const adminFeedbackSelectSql = sql`
  ${feedbackSelectSql},
  su.nickname AS submitter_nickname,
  hu.id AS handler_summary_id, hu.nickname AS handler_nickname
  FROM feedback f
  JOIN users su ON su.id = f.user_id
  LEFT JOIN users hu ON hu.id = f.handled_by
`

function adminFeedbackFromRow(row: Record<string, unknown>): AdminFeedbackRow {
  const feedback = feedbackFromRow(row)
  return {
    feedback,
    submitter: { id: feedback.userId, nickname: String(row.submitter_nickname) },
    handler:
      row.handler_summary_id === null || row.handler_summary_id === undefined
        ? null
        : { id: String(row.handler_summary_id), nickname: String(row.handler_nickname) },
  }
}

export function createSqlFeedbackStore(db: Db): FeedbackStore {
  return {
    async createFeedback(input) {
      return db.transaction(async (tx) => {
        // 按用户串行化「查重 → 计数 → 插入」：同一用户的并发提交在这把事务级咨询锁上排队，
        // 频控上限因此是精确的（不会两个请求都数到 9 再双双插入），也不影响其他用户。
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.userId}, 463))`)

        const existing = await tx.execute(sql`
          SELECT ${feedbackSelectSql}
          FROM feedback f
          WHERE f.user_id = ${input.userId} AND f.client_request_id = ${input.clientRequestId}
          LIMIT 1
        `)
        const existingRow = rowsOf(existing)[0]
        if (existingRow) return { kind: 'replayed' as const, row: feedbackFromRow(existingRow) }

        const counted = await tx.execute(sql`
          SELECT count(*)::int AS n FROM feedback
          WHERE user_id = ${input.userId} AND created_at > now() - interval '24 hours'
        `)
        if (Number(rowsOf(counted)[0]?.n ?? 0) >= input.dailyLimit) {
          return { kind: 'rate-limited' as const }
        }

        const inserted = await tx.execute(sql`
          INSERT INTO feedback AS f (id, user_id, client_request_id, type, content, contact)
          VALUES (${newId()}, ${input.userId}, ${input.clientRequestId},
                  ${input.type}::feedback_type, ${input.content}, ${input.contact})
          RETURNING ${feedbackSelectSql}
        `)
        const row = rowsOf(inserted)[0]
        if (!row) throw new Error('feedback INSERT 未返回行')
        return { kind: 'created' as const, row: feedbackFromRow(row) }
      })
    },

    async listMine(userId, criteria) {
      const conditions = [sql`f.user_id = ${userId}`]
      if (criteria.cursor) {
        conditions.push(cursorCondition(sql`f.created_at`, sql`f.id`, criteria.cursor))
      }
      const result = await db.execute(sql`
        SELECT ${feedbackSelectSql}
        FROM feedback f
        WHERE ${sql.join(conditions, sql` AND `)}
        ORDER BY f.created_at DESC, f.id DESC
        LIMIT ${criteria.limit}
      `)
      return rowsOf(result).map(feedbackFromRow)
    },

    async listAdmin(criteria) {
      const conditions: ReturnType<typeof sql>[] = []
      if (criteria.status) conditions.push(sql`f.status = ${criteria.status}::feedback_status`)
      if (criteria.type) conditions.push(sql`f.type = ${criteria.type}::feedback_type`)
      if (criteria.cursor) {
        conditions.push(cursorCondition(sql`f.created_at`, sql`f.id`, criteria.cursor))
      }
      const where = conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``
      const result = await db.execute(sql`
        SELECT ${adminFeedbackSelectSql}
        ${where}
        ORDER BY f.created_at DESC, f.id DESC
        LIMIT ${criteria.limit}
      `)
      return rowsOf(result).map(adminFeedbackFromRow)
    },

    async findAdmin(feedbackId) {
      const result = await db.execute(sql`
        SELECT ${adminFeedbackSelectSql}
        WHERE f.id = ${feedbackId}
        LIMIT 1
      `)
      const row = rowsOf(result)[0]
      return row ? adminFeedbackFromRow(row) : null
    },

    async handleFeedback(input) {
      return db.transaction(async (tx) => {
        const updated = await tx.execute(sql`
          UPDATE feedback
          SET status = ${input.result}::feedback_status,
              reply = ${input.reply},
              handling_note = ${input.note},
              handled_by = ${input.actorUserId},
              handled_at = now(),
              updated_at = now()
          WHERE id = ${input.feedbackId} AND status = 'PENDING'
          RETURNING id, user_id, type::text AS type
        `)
        const updatedRow = rowsOf(updated)[0]
        if (!updatedRow) {
          const existing = await tx.execute(
            sql`SELECT id FROM feedback WHERE id = ${input.feedbackId}`,
          )
          return rowsOf(existing).length > 0 ? ('conflict' as const) : ('not-found' as const)
        }

        // 审计快照只记状态与归属，不记正文 / 联系方式 / 回复原文（审计页对全体管理员可见，
        // 联系方式不该借审计扩散；回复原文在反馈行本身可查）。
        await tx.insert(adminAuditLogs).values({
          id: newId(),
          actorUserId: input.actorUserId,
          action: 'FEEDBACK_DECISION' satisfies AdminAuditAction,
          targetType: 'FEEDBACK' satisfies AdminAuditTargetType,
          targetId: input.feedbackId,
          before: jsonParam({ status: 'PENDING' }),
          after: jsonParam({
            status: input.result,
            type: String(updatedRow.type),
            submitterId: String(updatedRow.user_id),
          }),
          reason: input.note,
        })
        return 'applied' as const
      })
    },
  }
}
