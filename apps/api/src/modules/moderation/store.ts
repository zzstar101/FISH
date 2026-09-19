import type { Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { jsonParam } from '@fish/db/json'
import { jobs } from '@fish/db/schema/jobs'
import { listingModerationRecords } from '@fish/db/schema/moderation'
import { desc, eq, sql } from 'drizzle-orm'

export type ModerationDbTransaction = Parameters<Parameters<Db['transaction']>[0]>[0]
export type ModerationDecisionResult =
  | { kind: 'applied'; manualRecordId: string; previousStatus: string }
  | { kind: 'not-found' }
  | { kind: 'conflict' }

export type ModerationRecord = typeof listingModerationRecords.$inferSelect

export interface ModerationStore {
  listByListing(listingId: string, limit?: number): Promise<ModerationRecord[]>
  getById(id: string): Promise<ModerationRecord | null>
  /** 在调用方提供的事务中处理最新 REVIEW 记录；不负责 Admin 授权或审计。 */
  decideWithin(
    tx: ModerationDbTransaction,
    input: { recordId: string; decision: 'ALLOW' | 'BLOCK'; reason: string },
  ): Promise<ModerationDecisionResult>
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}

export function createSqlModerationStore(db: Db): ModerationStore {
  return {
    async listByListing(listingId, limit = 50) {
      return db
        .select()
        .from(listingModerationRecords)
        .where(eq(listingModerationRecords.listingId, listingId))
        .orderBy(desc(listingModerationRecords.createdAt), desc(listingModerationRecords.id))
        .limit(Math.min(Math.max(limit, 1), 100))
    },

    async getById(id) {
      const rows = await db
        .select()
        .from(listingModerationRecords)
        .where(eq(listingModerationRecords.id, id))
        .limit(1)
      return rows[0] ?? null
    },

    async decideWithin(tx, input) {
      const recordRows = await tx.execute(sql`
        SELECT id, listing_id, seller_id, action, title_snapshot, description_snapshot,
               rule_version, prior_listing_status::text AS prior_listing_status
        FROM listing_moderation_records
        WHERE id = ${input.recordId}
        FOR UPDATE
      `)
      const record = rowsOf(recordRows)[0]
      if (!record || record.listing_id == null) return { kind: 'not-found' }

      const listingRows = await tx.execute(sql`
        SELECT id, status::text AS status, moderation_status::text AS moderation_status
        FROM listings WHERE id = ${record.listing_id} FOR UPDATE
      `)
      const listing = rowsOf(listingRows)[0]
      if (!listing) return { kind: 'not-found' }
      if (listing.moderation_status !== 'REVIEW') return { kind: 'conflict' }

      const latestRows = await tx.execute(sql`
        SELECT id, action, decision FROM listing_moderation_records
        WHERE listing_id = ${record.listing_id}
          AND decision = 'REVIEW'
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `)
      const latest = rowsOf(latestRows)[0]
      if (!latest || latest.id !== record.id || latest.action === 'MANUAL_DECISION') {
        return { kind: 'conflict' }
      }

      const moderationStatus = input.decision === 'ALLOW' ? 'APPROVED' : 'BLOCKED'
      const listingStatus =
        input.decision === 'BLOCK'
          ? 'OFFLINE'
          : record.action === 'CREATE'
            ? 'ACTIVE'
            : String(record.prior_listing_status ?? 'OFFLINE')
      await tx.execute(sql`
        UPDATE listings
        SET moderation_status = ${moderationStatus}::listing_moderation_status,
            moderation_reason = ${input.reason},
            moderation_rule_version = ${record.rule_version},
            moderated_at = now(),
            status = ${listingStatus}::listing_status,
            updated_at = now()
        WHERE id = ${record.listing_id}
      `)

      const manualRecordId = newId()
      await tx.execute(sql`
        INSERT INTO listing_moderation_records
          (id, listing_id, seller_id, action, title_snapshot, description_snapshot,
           decision, matched_rules, matched_terms_masked, rule_version)
        VALUES (${manualRecordId}, ${record.listing_id}, ${record.seller_id}, 'MANUAL_DECISION',
                ${record.title_snapshot}, ${record.description_snapshot},
                ${input.decision}::moderation_decision, ${jsonParam([])}, ${jsonParam([])},
                ${record.rule_version})
      `)
      await tx.insert(jobs).values({
        id: newId(),
        type: 'MATCH_LISTING',
        payload: jsonParam({ listingId: String(record.listing_id) }),
      })

      return {
        kind: 'applied',
        manualRecordId,
        previousStatus: String(listing.moderation_status),
      }
    },
  }
}
