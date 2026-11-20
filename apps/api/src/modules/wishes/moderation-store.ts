import type { ModerationDecision } from '@fish/contracts/moderation/schema'
import type { Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { jsonParam } from '@fish/db/json'
import { adminAuditLogs } from '@fish/db/schema/admin'
import { sql } from 'drizzle-orm'
import type { ModerationProviderName, ModerationSuggestion } from '../moderation/providers/types'

export interface WishModerationQueueRow {
  id: string
  wish_id: string
  user_id: string
  content_version: number
  payload: { keyword?: unknown; description?: unknown }
  machine_decision: ModerationDecision
  decision: ModerationDecision
  status: 'PENDING' | 'SETTLED'
  provider: ModerationProviderName
  policy_version: string
  suggestion: ModerationSuggestion
  score: number | null
  matched_rules: unknown
  matched_terms_masked: unknown
  version: number
  created_at: Date | string
  keyword: string
  description: string | null
  author_nickname: string | null
}

export interface WishModerationRecordInput {
  keyword: string
  description: string | null
  version: number
  machineDecision: ModerationDecision
  decision: ModerationDecision
  provider: ModerationProviderName
  providerRequestId: string | null
  policyVersion: string
  suggestion: ModerationSuggestion
  label: string | null
  subLabel: string | null
  score: number | null
  matchedRules: string[]
  matchedTermsMasked: string[]
}

export type WishModerationDecision =
  | { outcome: 'not-found' }
  | { outcome: 'conflict' }
  | {
      outcome: 'applied' | 'replayed'
      recordId: string
      wishId: string
      decision: 'ALLOW' | 'BLOCK'
      /** true = 新建时待审（放行后首次进入公开池），false = 编辑待审。 */
      initial: boolean
      contentVersion: number
    }

export interface WishModerationStore {
  listPending(input: {
    before?: { createdAt: Date; id: string }
    limit: number
  }): Promise<WishModerationQueueRow[]>
  decide(input: {
    recordId: string
    decision: 'ALLOW' | 'BLOCK'
    reason: string
    version: number
    actorUserId: string
  }): Promise<WishModerationDecision>
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  const rows = (result as { rows?: unknown } | null)?.rows
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []
}

/**
 * 许愿墙待审队列（#694 M5）。与聊天待审同一姿态：审核记录是权威队列，专家放行/拒绝
 * 在**一个事务**里同时推进记录与愿望，CAS 版本防过期放行。
 */
export function createSqlWishModerationStore(db: Db): WishModerationStore {
  return {
    async listPending({ before, limit }) {
      const cursor = before
        ? sql`AND (r.created_at, r.id) < (${before.createdAt.toISOString()}::timestamptz, ${before.id}::uuid)`
        : sql``
      const result = await db.execute(sql`
        SELECT r.*, w.keyword, w.description, u.nickname AS author_nickname
        FROM wish_moderation_records r
        JOIN wishes w ON w.id = r.wish_id
        LEFT JOIN users u ON u.id = r.user_id
        WHERE r.status = 'PENDING' ${cursor}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ${limit}
      `)
      return rowsOf(result) as unknown as WishModerationQueueRow[]
    },

    async decide({ recordId, decision, reason, version, actorUserId }) {
      return db.transaction(async (tx) => {
        const locked = rowsOf(
          await tx.execute(sql`
            SELECT r.id, r.wish_id, r.content_version, r.status, r.decision, r.version,
                   r.payload, w.moderation_status, w.content_version AS wish_content_version
            FROM wish_moderation_records r
            JOIN wishes w ON w.id = r.wish_id
            WHERE r.id = ${recordId}::uuid
            FOR UPDATE OF r, w
          `),
        )[0]
        if (!locked) return { outcome: 'not-found' } as const

        const settledDecision =
          locked.decision === 'ALLOW' || locked.decision === 'BLOCK' ? locked.decision : null
        if (locked.status === 'SETTLED') {
          return settledDecision === decision
            ? {
                outcome: 'replayed' as const,
                recordId,
                wishId: String(locked.wish_id),
                decision,
                initial: Number(locked.content_version) === 1,
                contentVersion: Number(locked.wish_content_version),
              }
            : { outcome: 'conflict' as const }
        }
        if (Number(locked.version) !== version) return { outcome: 'conflict' } as const

        const initial =
          Number(locked.content_version) === 1 && locked.moderation_status === 'PENDING_REVIEW'

        const recordVersion = Number(locked.content_version)
        if (decision === 'ALLOW') {
          const updated = initial
            ? await tx.execute(sql`
                UPDATE wishes SET moderation_status = 'APPROVED',
                                  pending_keyword = NULL, pending_description = NULL,
                                  pending_version = NULL, updated_at = clock_timestamp()
                WHERE id = ${locked.wish_id}::uuid AND moderation_status = 'PENDING_REVIEW'
                RETURNING id
              `)
            : await tx.execute(sql`
                UPDATE wishes
                SET keyword = COALESCE(r.payload ->> 'keyword', keyword),
                    description = CASE
                      WHEN jsonb_exists(r.payload, 'description') THEN r.payload ->> 'description'
                      ELSE description
                    END,
                    content_version = ${recordVersion},
                    pending_keyword = NULL,
                    pending_description = NULL,
                    pending_version = NULL,
                    moderation_status = 'APPROVED',
                    updated_at = clock_timestamp()
                FROM wish_moderation_records r
                WHERE wishes.id = ${locked.wish_id}::uuid
                  AND r.id = ${recordId}::uuid
                  AND wishes.moderation_status <> 'REJECTED'
                  AND wishes.pending_version = ${recordVersion}
                RETURNING wishes.id
              `)
          if (rowsOf(updated).length === 0) return { outcome: 'conflict' } as const
        } else {
          const updated = initial
            ? await tx.execute(sql`
                UPDATE wishes SET moderation_status = 'REJECTED',
                                  pending_keyword = NULL, pending_description = NULL,
                                  pending_version = NULL, updated_at = clock_timestamp()
                WHERE id = ${locked.wish_id}::uuid AND moderation_status = 'PENDING_REVIEW'
                RETURNING id
              `)
            : await tx.execute(sql`
                UPDATE wishes
                SET pending_keyword = NULL, pending_description = NULL, pending_version = NULL,
                    updated_at = clock_timestamp()
                WHERE id = ${locked.wish_id}::uuid
                  AND moderation_status <> 'REJECTED'
                  AND pending_version = ${recordVersion}
                RETURNING id
              `)
          if (rowsOf(updated).length === 0) return { outcome: 'conflict' } as const
        }

        await tx.execute(sql`
          UPDATE wish_moderation_records
          SET decision = ${decision},
              status = 'SETTLED',
              reviewed_by = ${actorUserId}::uuid,
              reviewed_at = clock_timestamp(),
              review_note = ${reason},
              version = version + 1,
              updated_at = clock_timestamp()
          WHERE id = ${recordId}::uuid
        `)

        // 同一愿望的其它待审记录已被本次结算取代：直接清掉，避免队列里永远留一条无法收敛的
        // PENDING（同一内容版本也可能因为历史分配而重复）。
        await tx.execute(sql`
          DELETE FROM wish_moderation_records
          WHERE wish_id = ${locked.wish_id}::uuid AND status = 'PENDING' AND id <> ${recordId}::uuid
        `)

        await tx.insert(adminAuditLogs).values({
          id: newId(),
          actorUserId,
          action: 'WISH_MODERATION_DECISION',
          targetType: 'WISH_MODERATION_RECORD',
          targetId: recordId,
          before: jsonParam({ status: 'PENDING', decision: locked.machine_decision, version }),
          after: jsonParam({
            status: 'SETTLED',
            decision,
            wishId: String(locked.wish_id),
            contentVersion: recordVersion,
            moderationStatus: decision === 'ALLOW' ? 'APPROVED' : 'REJECTED',
          }),
          reason,
        })

        return {
          outcome: 'applied' as const,
          recordId,
          wishId: String(locked.wish_id),
          decision,
          initial,
          contentVersion: recordVersion,
        }
      })
    },
  }
}

/** 与愿望同事务写入一条待审记录（供 wishes store 在创建/编辑事务里调用）。 */
export async function insertWishModerationRecord(
  tx: Pick<Db, 'execute'>,
  wishId: string,
  userId: string,
  record: WishModerationRecordInput,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO wish_moderation_records (
      id, wish_id, user_id, content_version, payload,
      machine_decision, decision, status, provider, provider_request_id, policy_version,
      suggestion, label, sub_label, score, matched_rules, matched_terms_masked
    ) VALUES (
      ${newId()}, ${wishId}::uuid, ${userId}::uuid, ${record.version},
      jsonb_build_object('keyword', ${record.keyword}::text, 'description', ${record.description}::text),
      ${record.machineDecision}, ${record.decision}, 'PENDING', ${record.provider},
      ${record.providerRequestId}, ${record.policyVersion}, ${record.suggestion}, ${record.label},
      ${record.subLabel}, ${record.score},
      ${JSON.stringify(record.matchedRules)}::jsonb, ${JSON.stringify(record.matchedTermsMasked)}::jsonb
    )
  `)
}
