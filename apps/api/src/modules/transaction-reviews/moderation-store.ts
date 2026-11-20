import { createHash } from 'node:crypto'
import { MAX_IMAGE_BYTES } from '@fish/contracts/listings/schema'
import type { ModerationDecision } from '@fish/contracts/moderation/schema'
import type { Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { jsonParam } from '@fish/db/json'
import { adminAuditLogs } from '@fish/db/schema/admin'
import { reviewModerationRecords } from '@fish/db/schema/review-moderation'
import { transactionReviewImages } from '@fish/db/schema/transaction-reviews'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  isReviewModerationMediaKey,
  REVIEW_MEDIA_PUBLIC_PREFIX,
  REVIEW_MODERATION_MEDIA_PREFIX,
  reviewModerationMediaPrefix,
} from '../uploads/review-media'
import type { MediaStorage } from '../uploads/storage'

export type ReviewModerationRow = typeof reviewModerationRecords.$inferSelect

/** 评价读侧只需要「这个键是谁的、当前有效结论」。 */
export interface ReviewModerationLookupRow {
  finalKey: string
  userId: string
  moderationDecision: ModerationDecision
  settledDecision: ModerationDecision | null
  contentDigest: string
}

export function effectiveReviewModerationDecision(
  row: Pick<ReviewModerationRow, 'moderationDecision' | 'settledDecision'>,
): ModerationDecision {
  return row.settledDecision ?? row.moderationDecision
}

/** 管理端队列一行（SQL 平铺结果，service 映射成契约）。 */
export interface ReviewModerationQueueRow {
  id: string
  userId: string
  transactionId: string
  finalKey: string | null
  contentType: string
  sizeBytes: number
  contentDigest: string
  moderationDecision: ModerationDecision
  provider: string
  providerRequestId: string | null
  policyVersion: string
  bizType: string | null
  suggestion: string | null
  label: string | null
  subLabel: string | null
  score: number | null
  matchedRules: string[]
  matchedTermsMasked: string[]
  version: number
  createdAt: string
  createdAtCursor: string
  authorNickname: string
  listingId: string
  listingTitle: string
  reviewId: string | null
  reviewRating: string | null
  reviewBody: string | null
  reviewCreatedAt: string | null
}

export interface ReviewModerationInsert {
  userId: string
  transactionId: string
  stagingKey: string
  finalKey: string | null
  contentType: string
  sizeBytes: number
  contentDigest: string
  providerMd5: string | null
  moderationDecision: ModerationDecision
  provider: string
  providerRequestId: string | null
  policyVersion: string
  bizType: string | null
  suggestion: string | null
  label: string | null
  subLabel: string | null
  score: number | null
  matchedRules: string[]
  matchedTermsMasked: string[]
}

export type ReviewModerationDecideOutcome =
  | { outcome: 'not-found' }
  | { outcome: 'conflict' }
  | { outcome: 'applied' | 'replayed'; finalKey: string | null; version: number }

/** 结算需要搬字节 / 改写评价引用；存在性由 service 在路由层再收口。 */
export type ReviewModerationSettlementStorage = Pick<
  MediaStorage,
  'readMediaBytes' | 'writeMediaBytes' | 'writeMediaBytesIfAbsent'
>

/**
 * 结算期的确定性失败（不是上游故障）：
 * - `MEDIA_UNAVAILABLE`：存储缺能力、对象读不到、写入失败 —— 503，稍后重试；
 * - `MEDIA_CHANGED`：私有快照的字节与落库摘要不一致（对象被替换/损坏）—— 409，拒绝放行。
 */
export class ReviewModerationStoreError extends Error {
  constructor(
    readonly code: 'MEDIA_UNAVAILABLE' | 'MEDIA_CHANGED',
    message: string,
  ) {
    super(message)
    this.name = 'ReviewModerationStoreError'
  }
}

export interface ReviewModerationStore {
  /** 幂等查找：同一 `(userId, stagingKey, 当前字节内容)` 的既有结论。 */
  findByDigest(input: {
    userId: string
    stagingKey: string
    contentDigest: string
  }): Promise<ReviewModerationRow | null>
  /** 同一 staging 键最近一条记录：staging 被清理后 confirm 重试仍可幂等。 */
  findByStagingKey(input: {
    userId: string
    stagingKey: string
  }): Promise<ReviewModerationRow | null>
  findByFinalKey(finalKey: string): Promise<ReviewModerationLookupRow | null>
  findByFinalKeys(finalKeys: string[]): Promise<ReviewModerationLookupRow[]>
  /** 并发 confirm 撞唯一索引时返回 null；调用方改读先落库的那一行。 */
  insert(input: ReviewModerationInsert): Promise<ReviewModerationRow | null>
  listPending(input: {
    before: { createdAt: string; id: string } | null
    limit: number
  }): Promise<ReviewModerationQueueRow[]>
  /** 管理员读字节：只返回仍可读的 final 键；记录不存在/无键 → null。 */
  findMediaSnapshot(
    recordId: string,
  ): Promise<{ objectKey: string; contentType: string; sizeBytes: number } | null>
  decide(input: {
    recordId: string
    decision: 'ALLOW' | 'BLOCK'
    reason: string
    version: number
    actorUserId: string
  }): Promise<ReviewModerationDecideOutcome>
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === 'string')
        : []
    } catch {
      return []
    }
  }
  return []
}

function lookupOf(row: ReviewModerationRow): ReviewModerationLookupRow {
  return {
    finalKey: row.finalKey as string,
    userId: row.userId,
    moderationDecision: row.moderationDecision,
    settledDecision: row.settledDecision,
    contentDigest: row.contentDigest,
  }
}

/** 时间戳取毫秒 ISO 进契约、微秒 ISO 进游标（与评价列表同一手法）。 */
const RECORD_TIME_COLUMNS = sql`
  to_char(rr.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_iso,
  to_char(rr.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor`

export function createSqlReviewModerationStore(
  db: Db,
  storage: ReviewModerationSettlementStorage,
): ReviewModerationStore {
  return {
    async findByDigest({ userId, stagingKey, contentDigest }) {
      const [row] = await db
        .select()
        .from(reviewModerationRecords)
        .where(
          and(
            eq(reviewModerationRecords.userId, userId),
            eq(reviewModerationRecords.stagingKey, stagingKey),
            eq(reviewModerationRecords.contentDigest, contentDigest),
          ),
        )
        .limit(1)
      return row ?? null
    },

    async findByStagingKey({ userId, stagingKey }) {
      const [row] = await db
        .select()
        .from(reviewModerationRecords)
        .where(
          and(
            eq(reviewModerationRecords.userId, userId),
            eq(reviewModerationRecords.stagingKey, stagingKey),
          ),
        )
        .orderBy(desc(reviewModerationRecords.createdAt))
        .limit(1)
      return row ?? null
    },

    async findByFinalKey(finalKey) {
      const [row] = await db
        .select()
        .from(reviewModerationRecords)
        .where(eq(reviewModerationRecords.finalKey, finalKey))
        .limit(1)
      return row ? lookupOf(row) : null
    },

    async findByFinalKeys(finalKeys) {
      if (finalKeys.length === 0) return []
      const rows = await db
        .select()
        .from(reviewModerationRecords)
        .where(inArray(reviewModerationRecords.finalKey, finalKeys))
      return rows.map(lookupOf)
    },

    async insert(input) {
      const [row] = await db
        .insert(reviewModerationRecords)
        .values({ id: newId(), ...input })
        .onConflictDoNothing()
        .returning()
      return row ?? null
    },

    async listPending({ before, limit }) {
      const cursor = before
        ? sql`AND (rr.created_at, rr.id) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`
        : sql``
      const rows = rowsOf(
        await db.execute(sql`
          SELECT
            rr.id,
            rr.user_id,
            rr.transaction_id,
            rr.final_key,
            rr.content_type,
            rr.size_bytes,
            rr.content_digest,
            rr.moderation_decision,
            rr.provider,
            rr.provider_request_id,
            rr.policy_version,
            rr.biz_type,
            rr.suggestion,
            rr.label,
            rr.sub_label,
            rr.score,
            rr.matched_rules,
            rr.matched_terms_masked,
            rr.version,
            ${RECORD_TIME_COLUMNS},
            u.nickname AS author_nickname,
            l.id AS listing_id,
            l.title AS listing_title,
            ctx.review_id,
            ctx.review_rating,
            ctx.review_body,
            ctx.review_created_at
          FROM review_moderation_records rr
          JOIN users u ON u.id = rr.user_id
          JOIN transactions t ON t.id = rr.transaction_id
          JOIN listings l ON l.id = t.listing_id
          -- 只列“已被评价引用”的图片：确认后没提交评价的图片不进人工队列，
          -- 评价删除后也自然从队列消失（队列只服务评价上下文）。
          JOIN LATERAL (
            SELECT
              rv.id AS review_id,
              rv.rating::text AS review_rating,
              rv.body AS review_body,
              to_char(rv.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS review_created_at
            FROM transaction_review_images ri
            JOIN transaction_reviews rv ON rv.id = ri.review_id
            WHERE ri.object_key = rr.final_key
            ORDER BY rv.created_at ASC, rv.id ASC
            LIMIT 1
          ) ctx ON true
          WHERE rr.settled_decision IS NULL
            AND rr.moderation_decision = 'REVIEW'
            ${cursor}
          ORDER BY rr.created_at DESC, rr.id DESC
          LIMIT ${limit + 1}
        `),
      )
      return rows.map((row) => ({
        id: String(row.id),
        userId: String(row.user_id),
        transactionId: String(row.transaction_id),
        finalKey: (row.final_key as string | null) ?? null,
        contentType: String(row.content_type),
        sizeBytes: Number(row.size_bytes),
        contentDigest: String(row.content_digest),
        moderationDecision: row.moderation_decision as ModerationDecision,
        provider: String(row.provider),
        providerRequestId: (row.provider_request_id as string | null) ?? null,
        policyVersion: String(row.policy_version),
        bizType: (row.biz_type as string | null) ?? null,
        suggestion: (row.suggestion as string | null) ?? null,
        label: (row.label as string | null) ?? null,
        subLabel: (row.sub_label as string | null) ?? null,
        score: row.score === null || row.score === undefined ? null : Number(row.score),
        matchedRules: stringArray(row.matched_rules),
        matchedTermsMasked: stringArray(row.matched_terms_masked),
        version: Number(row.version),
        createdAt: String(row.created_at_iso),
        createdAtCursor: String(row.created_at_cursor),
        authorNickname: String(row.author_nickname),
        listingId: String(row.listing_id),
        listingTitle: String(row.listing_title),
        reviewId: (row.review_id as string | null) ?? null,
        reviewRating: (row.review_rating as string | null) ?? null,
        reviewBody: (row.review_body as string | null) ?? null,
        reviewCreatedAt: (row.review_created_at as string | null) ?? null,
      }))
    },

    async findMediaSnapshot(recordId) {
      const [row] = await db
        .select({
          objectKey: reviewModerationRecords.finalKey,
          contentType: reviewModerationRecords.contentType,
          sizeBytes: reviewModerationRecords.sizeBytes,
        })
        .from(reviewModerationRecords)
        .where(eq(reviewModerationRecords.id, recordId))
        .limit(1)
      if (!row?.objectKey) return null
      return { objectKey: row.objectKey, contentType: row.contentType, sizeBytes: row.sizeBytes }
    },

    async decide({ recordId, decision, reason, version, actorUserId }) {
      return db.transaction(async (tx) => {
        const locked = rowsOf(
          await tx.execute(sql`
            SELECT *
            FROM review_moderation_records
            WHERE id = ${recordId}::uuid
            FOR UPDATE
          `),
        )[0]
        if (!locked) return { outcome: 'not-found' } as const

        const currentVersion = Number(locked.version)
        const settledDecision = locked.settled_decision as ModerationDecision | null
        if (settledDecision !== null) {
          return settledDecision === decision
            ? ({
                outcome: 'replayed',
                finalKey: (locked.final_key as string | null) ?? null,
                version: currentVersion,
              } as const)
            : ({ outcome: 'conflict' } as const)
        }
        if (locked.moderation_decision !== 'REVIEW') return { outcome: 'conflict' } as const
        if (currentVersion !== version) return { outcome: 'conflict' } as const

        const userId = String(locked.user_id)
        const privateKey = locked.final_key as string | null
        let nextFinalKey = privateKey

        if (decision === 'ALLOW') {
          if (!privateKey || !isReviewModerationMediaKey(privateKey)) {
            throw new ReviewModerationStoreError('MEDIA_CHANGED', '待审图片没有私有快照键')
          }
          // 键归属与用户必须一致：即便台账被手工改过，也不允许放行别人的私有对象。
          if (!privateKey.startsWith(reviewModerationMediaPrefix(userId))) {
            throw new ReviewModerationStoreError('MEDIA_CHANGED', '待审图片键不属于该用户')
          }
          if (!storage.readMediaBytes) {
            throw new ReviewModerationStoreError('MEDIA_UNAVAILABLE', '对象存储未提供读取能力')
          }
          const bytes = await storage.readMediaBytes(privateKey, MAX_IMAGE_BYTES)
          if (!bytes) {
            throw new ReviewModerationStoreError('MEDIA_UNAVAILABLE', '待审图片快照已不存在')
          }
          if (bytes.byteLength !== Number(locked.size_bytes)) {
            throw new ReviewModerationStoreError('MEDIA_CHANGED', '待审图片大小与审核记录不一致')
          }
          const digest = createHash('sha256').update(bytes).digest('hex')
          if (digest !== locked.content_digest) {
            throw new ReviewModerationStoreError('MEDIA_CHANGED', '待审图片字节与审核摘要不一致')
          }

          // 同一 media id 只换前缀：放行不会产生第二个可引用键。
          const publicKey = `${REVIEW_MEDIA_PUBLIC_PREFIX}${privateKey.slice(
            REVIEW_MODERATION_MEDIA_PREFIX.length,
          )}`
          const contentType = String(locked.content_type)
          if (storage.writeMediaBytesIfAbsent) {
            const created = await storage.writeMediaBytesIfAbsent(publicKey, bytes, contentType)
            if (!created) {
              // 崩溃重试时公开对象可能已在：必须仍是同一份字节，否则拒绝放行。
              const existing = await storage.readMediaBytes?.(publicKey, MAX_IMAGE_BYTES)
              if (
                !existing ||
                existing.byteLength !== bytes.byteLength ||
                createHash('sha256').update(existing).digest('hex') !== digest
              ) {
                throw new ReviewModerationStoreError(
                  'MEDIA_CHANGED',
                  '公开键已存在且字节与待审快照不一致',
                )
              }
            }
          } else if (storage.writeMediaBytes) {
            await storage.writeMediaBytes(publicKey, bytes, contentType)
          } else {
            throw new ReviewModerationStoreError('MEDIA_UNAVAILABLE', '对象存储未提供写入能力')
          }

          nextFinalKey = publicKey
          await tx
            .update(transactionReviewImages)
            .set({ objectKey: publicKey })
            .where(eq(transactionReviewImages.objectKey, privateKey))
        }

        await tx.execute(sql`
          UPDATE review_moderation_records
          SET settled_decision = ${decision},
              settled_at = clock_timestamp(),
              final_key = ${nextFinalKey},
              reviewed_by = ${actorUserId}::uuid,
              reviewed_at = clock_timestamp(),
              review_note = ${reason},
              version = version + 1,
              updated_at = clock_timestamp()
          WHERE id = ${recordId}::uuid
        `)

        await tx.insert(adminAuditLogs).values({
          id: newId(),
          actorUserId,
          action: 'REVIEW_MODERATION_DECISION',
          targetType: 'REVIEW_MODERATION_RECORD',
          targetId: recordId,
          // 不记对象键与图片字节：审计只需要结论与版本，存储布局不应扩散。
          before: jsonParam({
            status: 'PENDING',
            machineDecision: locked.moderation_decision,
            suggestion: locked.suggestion,
            version,
          }),
          after: jsonParam({
            status: 'SETTLED',
            decision,
            promotedToPublic: decision === 'ALLOW',
            version: version + 1,
          }),
          reason,
        })

        return {
          outcome: 'applied',
          finalKey: nextFinalKey,
          version: version + 1,
        } as const
      })
    },
  }
}
