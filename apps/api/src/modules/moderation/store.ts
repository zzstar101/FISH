import type { Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { jsonParam } from '@fish/db/json'
import { jobs } from '@fish/db/schema/jobs'
import { listingModerationRecords } from '@fish/db/schema/moderation'
import { notifications } from '@fish/db/schema/notifications'
import { desc, eq, sql } from 'drizzle-orm'

export type ModerationDbTransaction = Parameters<Parameters<Db['transaction']>[0]>[0]
export type ModerationDecisionResult =
  | { kind: 'applied'; manualRecordId: string; previousStatus: string }
  | { kind: 'not-found' }
  | { kind: 'conflict' }

export type ModerationRecord = typeof listingModerationRecords.$inferSelect

/**
 * 图片结算**拒绝**本次人工结论（#286）：调用方必须让整个决策事务回滚，并把拒绝原因翻译成
 * 客户端可读的状态码。`code` 区分三种情形：
 *
 * - `IMAGE_BLOCKED`：这张图已被人工阻断，不能借本次放行把字节放进公开前缀（结论本身站不住）；
 * - `SETTLEMENT_FAILED`：结算过程失败（存储不支持读写、并发抢占），重试可能成功；
 * - `SETTLEMENT_DATA_MISSING`：台账行 / 对象缺失，是**持久**状态，重试永远不会成功，需要人工排查。
 */
export type ModerationSettlementErrorCode =
  | 'IMAGE_BLOCKED'
  | 'SETTLEMENT_FAILED'
  | 'SETTLEMENT_DATA_MISSING'

export class ModerationSettlementError extends Error {
  readonly code: ModerationSettlementErrorCode

  constructor(code: ModerationSettlementErrorCode, message: string) {
    super(message)
    this.name = 'ModerationSettlementError'
    this.code = code
  }
}

/**
 * 图片结算钩子（#286 复审 blocker 1）：人工结论落库后、**同一事务内**结算该 Listing 的审核中图片。
 * 从 uploads 域注入，`moderation` 域因此不需要知道对象存储与前缀规则（实现见
 * `modules/uploads/listing-media-settlement.ts`）。
 */
export type SettleListingMediaHook = (
  tx: ModerationDbTransaction,
  input: { listingId: string; decision: 'ALLOW' | 'BLOCK' },
) => Promise<void>

export interface ModerationStoreOptions {
  settleListingMedia?: SettleListingMediaHook
}

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

export function createSqlModerationStore(
  db: Db,
  options: ModerationStoreOptions = {},
): ModerationStore {
  const { settleListingMedia } = options
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
            updated_at = clock_timestamp()
        WHERE id = ${record.listing_id}
      `)

      // #286 复审 blocker 1：人工结论必须与图片结算同事务落库，否则卖家下一次不改图的文本编辑
      // 会从 `listing_images` 重新读到机器 `REVIEW`，把刚放行的商品压回人工队列。
      if (settleListingMedia) {
        await settleListingMedia(tx, {
          listingId: String(record.listing_id),
          decision: input.decision,
        })
      }

      const manualRecordId = newId()
      await tx.execute(sql`
        INSERT INTO listing_moderation_records
          (id, listing_id, seller_id, action, title_snapshot, description_snapshot,
           decision, matched_rules, matched_terms_masked, rule_version, provider)
        VALUES (${manualRecordId}, ${record.listing_id}, ${record.seller_id}, 'MANUAL_DECISION',
                ${record.title_snapshot}, ${record.description_snapshot},
                ${input.decision}::moderation_decision, ${jsonParam([])}, ${jsonParam([])},
                ${record.rule_version}, 'MANUAL')
      `)
      // 人工放行同样要刷新语义向量（#322 M1）：这是待审商品进入匹配链路的入口之一，
      // 与 `governance` / `listings store` 的成对投递保持同一条规则。
      // `ON CONFLICT DO NOTHING` 对应 `EMBED_LISTING` 的部分唯一索引（待跑时再投不算错误）。
      //
      // **顺序即语义（#322 M4）**：`EMBED_LISTING` 必须先于 `MATCH_LISTING` 插入。同事务里两条
      // job 的 `run_at` 相同，队列按 `(run_at, id)` 领取，而 `id = newId()` 同毫秒单调递增 ⇒
      // 领取序 = 插入序。反序会让首轮 MATCH 跑在向量落库前、按 M2 降级契约永久落 v1。
      await tx
        .insert(jobs)
        .values({
          id: newId(),
          type: 'EMBED_LISTING',
          payload: jsonParam({ listingId: String(record.listing_id) }),
        })
        .onConflictDoNothing()

      await tx.insert(jobs).values({
        id: newId(),
        type: 'MATCH_LISTING',
        payload: jsonParam({ listingId: String(record.listing_id) }),
      })

      // 审核出结果 → MODERATION 通知（任务一 #89）：与决策**同事务**落库，
      // 决策回滚则通知不存在；收件人是商品卖家，客户端按 outcome 渲染通过/未通过。
      // `jsonParam` 不能省：裸对象会落成 jsonb 字符串，读侧的 `jsonb_typeof = 'object'`
      // 谓词会把整行判成不可投影（见 `packages/db/src/json.ts`）。
      await tx.insert(notifications).values({
        id: newId(),
        userId: String(record.seller_id),
        type: 'MODERATION',
        payload: jsonParam({
          listingId: String(record.listing_id),
          outcome: input.decision === 'ALLOW' ? 'APPROVED' : 'REJECTED',
        }),
      })

      return {
        kind: 'applied',
        manualRecordId,
        previousStatus: String(listing.moderation_status),
      }
    },
  }
}
