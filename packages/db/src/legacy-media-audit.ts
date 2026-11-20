import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { Db } from './client'
import { disputes } from './schema/disputes'
import {
  legacyMediaAuditItems,
  type legacyMediaAuditStatusEnum,
  type legacyMediaPublicVisibilityEnum,
  type legacyMediaSourceKindEnum,
} from './schema/legacy-media-audit'
import { listingImages, listings } from './schema/listings'
import { listingModerationRecords, type moderationDecisionEnum } from './schema/moderation'
import { transactions } from './schema/transactions'
import { users } from './schema/users'

export type LegacyMediaDecision = (typeof moderationDecisionEnum.enumValues)[number]
export type LegacyMediaAuditStatus = (typeof legacyMediaAuditStatusEnum.enumValues)[number]
export type LegacyMediaSourceKind = (typeof legacyMediaSourceKindEnum.enumValues)[number]
export type LegacyMediaPublicVisibility =
  (typeof legacyMediaPublicVisibilityEnum.enumValues)[number]

export type LegacyMediaAuditItem = typeof legacyMediaAuditItems.$inferSelect

const DEFAULT_AUDIT_MAX_ATTEMPTS = 3

/**
 * 可重复、可断点续跑的存量图片盘点。
 *
 * 只读业务表，写 `legacy_media_audit_items`；同一对象键重复盘点只更新引用/归属/可见性，
 * **不覆盖补审结论**。返回本轮命中的对象键数（含已存在行）。
 */
export async function syncLegacyMediaInventoryBatch(
  db: Db,
  options: { limit?: number; afterKey?: string | null } = {},
): Promise<{ scanned: number; nextCursor: string | null }> {
  const limit = Math.min(1000, Math.max(1, Math.trunc(options.limit ?? 500)))
  const afterKey = options.afterKey ?? null
  const rows = await db.execute<{ scanned: number; next_cursor: string | null }>(sql`
    WITH refs AS (
      SELECT
        li.object_key,
        'LISTING'::text AS source_kind,
        'listing_images'::text AS source_table,
        1 AS priority,
        jsonb_build_object(
          'kind', 'LISTING',
          'sourceTable', 'listing_images',
          'ownerUserId', l.seller_id,
          'listingId', l.id,
          'imageId', li.id
        ) AS ref,
        l.seller_id AS owner_user_id,
        1 AS is_listing
      FROM listing_images li
      JOIN listings l ON l.id = li.listing_id
      WHERE li.object_key LIKE 'listings/%'
        AND li.object_key NOT LIKE 'listings/seed-%'
        AND NOT EXISTS (
          SELECT 1 FROM listing_media_objects mo WHERE mo.final_key = li.object_key
        )

      UNION ALL

      SELECT
        tri.object_key,
        'REVIEW'::text,
        'transaction_review_images'::text,
        2,
        jsonb_build_object(
          'kind', 'REVIEW',
          'sourceTable', 'transaction_review_images',
          'ownerUserId', tr.author_id,
          'reviewId', tr.id,
          'transactionId', tr.transaction_id,
          'imageId', tri.id
        ),
        tr.author_id,
        0
      FROM transaction_review_images tri
      JOIN transaction_reviews tr ON tr.id = tri.review_id
      WHERE tri.object_key LIKE 'reviews/%'
        AND NOT EXISTS (
          SELECT 1 FROM review_moderation_records rm WHERE rm.final_key = tri.object_key
        )

      UNION ALL

      SELECT
        mm.object_key,
        'CHAT'::text,
        'message_media'::text,
        3,
        jsonb_build_object(
          'kind', 'CHAT',
          'sourceTable', 'message_media',
          'ownerUserId', mm.owner_id,
          'mediaId', mm.id,
          'messageId', mm.message_id,
          'conversationId', mm.conversation_id
        ),
        mm.owner_id,
        0
      FROM message_media mm
      WHERE mm.kind = 'IMAGE'
        AND NOT EXISTS (
          SELECT 1 FROM chat_moderation_records cm WHERE cm.message_id = mm.message_id
        )
    ),
    keys AS (
      SELECT DISTINCT object_key
      FROM refs
      WHERE (${afterKey}::text IS NULL OR object_key > ${afterKey})
      ORDER BY object_key
      LIMIT ${limit}
    ),
    agg AS (
      SELECT
        r.object_key,
        (array_agg(r.source_kind ORDER BY r.priority, r.source_table))[1] AS source_kind,
        (array_agg(r.source_table ORDER BY r.priority, r.source_table))[1] AS source_table,
        (array_agg(r.owner_user_id ORDER BY r.priority, r.source_table))[1] AS owner_user_id,
        jsonb_agg(r.ref ORDER BY r.priority, r.source_table) AS source_refs,
        count(DISTINCT r.owner_user_id)::int AS owner_count,
        count(*)::int AS reference_count,
        count(*) FILTER (WHERE r.is_listing = 1)::int AS listing_reference_count,
        CASE
          WHEN r.object_key ~ '^listings/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
            THEN 'LEGACY_PROXY'
          WHEN r.object_key LIKE 'listings/%' THEN 'PUBLIC_DIRECT'
          WHEN r.object_key LIKE 'reviews/%'
            OR r.object_key LIKE 'review-moderation-media/%' THEN 'PRIVATE_PROXY'
          ELSE 'PRIVATE'
        END AS public_visibility
      FROM refs r
      JOIN keys k ON k.object_key = r.object_key
      GROUP BY r.object_key
    ),
    inserted AS (
    INSERT INTO legacy_media_audit_items (
      object_key,
      source_kind,
      source_table,
      source_refs,
      owner_user_id,
      owner_count,
      reference_count,
      listing_reference_count,
      public_visibility,
      existing_decision,
      inventory_updated_at,
      updated_at
    )
    SELECT
      a.object_key,
      a.source_kind::legacy_media_source_kind,
      a.source_table,
      a.source_refs,
      a.owner_user_id,
      a.owner_count,
      a.reference_count,
      a.listing_reference_count,
      a.public_visibility::legacy_media_public_visibility,
      COALESCE(
        (
          SELECT COALESCE(mo.settled_decision, mo.moderation_decision)
          FROM listing_media_objects mo
          WHERE mo.final_key = a.object_key
          LIMIT 1
        ),
        (
          SELECT COALESCE(rm.settled_decision, rm.moderation_decision)
          FROM review_moderation_records rm
          WHERE rm.final_key = a.object_key
          LIMIT 1
        ),
        (
          SELECT cm.decision
          FROM chat_moderation_records cm
          JOIN message_media mm2 ON mm2.message_id = cm.message_id
          WHERE mm2.object_key = a.object_key
          LIMIT 1
        )
      ),
      now(),
      now()
    FROM agg a
    ON CONFLICT (object_key) DO UPDATE SET
      source_kind = EXCLUDED.source_kind,
      source_table = EXCLUDED.source_table,
      source_refs = EXCLUDED.source_refs,
      owner_user_id = EXCLUDED.owner_user_id,
      owner_count = EXCLUDED.owner_count,
      reference_count = EXCLUDED.reference_count,
      listing_reference_count = EXCLUDED.listing_reference_count,
      public_visibility = EXCLUDED.public_visibility,
      existing_decision = COALESCE(
        EXCLUDED.existing_decision,
        legacy_media_audit_items.existing_decision
      ),
      inventory_updated_at = now(),
      updated_at = now()
    RETURNING object_key
    )
    SELECT
      (SELECT count(*)::int FROM inserted) AS scanned,
      (SELECT max(object_key) FROM keys) AS next_cursor
  `)

  const [row] = [...rows]
  return {
    scanned: row?.scanned ?? 0,
    nextCursor: row?.next_cursor ?? null,
  }
}

/**
 * 反复调用批次盘点直到没有新键。每批独立提交，因此中途中断后重跑会从下一批继续，
 * 已经写入的对象不会重复插入、也不会覆盖补审结论。
 */
export async function syncLegacyMediaInventory(
  db: Db,
  options: { batchSize?: number } = {},
): Promise<{ scanned: number }> {
  const batchSize = options.batchSize ?? 500
  let scanned = 0
  let cursor: string | null = null
  for (;;) {
    const batch = await syncLegacyMediaInventoryBatch(db, { limit: batchSize, afterKey: cursor })
    scanned += batch.scanned
    if (batch.nextCursor === null) return { scanned }
    cursor = batch.nextCursor
  }
}

export type LegacyMediaInventorySummary = {
  total: number
  byStatus: Record<LegacyMediaAuditStatus, number>
  byDecision: Record<LegacyMediaDecision | 'UNAUDITED', number>
  bySourceKind: Record<LegacyMediaSourceKind, number>
  byPublicVisibility: Record<LegacyMediaPublicVisibility, number>
  rows: Array<{
    sourceKind: LegacyMediaSourceKind
    auditStatus: LegacyMediaAuditStatus
    decision: LegacyMediaDecision | null
    publicVisibility: LegacyMediaPublicVisibility
    count: number
  }>
}

/** 运维用的盘点汇总：总数、按状态/结论/来源/可见性分布。 */
export async function summarizeLegacyMediaInventory(db: Db): Promise<LegacyMediaInventorySummary> {
  const rows = await db.execute<{
    source_kind: LegacyMediaSourceKind
    audit_status: LegacyMediaAuditStatus
    decision: LegacyMediaDecision | null
    public_visibility: LegacyMediaPublicVisibility
    count: number
  }>(sql`
    SELECT
      source_kind,
      audit_status,
      decision,
      public_visibility,
      count(*)::int AS count
    FROM legacy_media_audit_items
    GROUP BY source_kind, audit_status, decision, public_visibility
    ORDER BY source_kind, audit_status, decision NULLS FIRST, public_visibility
  `)

  const byStatus: Record<LegacyMediaAuditStatus, number> = {
    PENDING: 0,
    AUDITED: 0,
    FAILED: 0,
  }
  const byDecision: Record<LegacyMediaDecision | 'UNAUDITED', number> = {
    ALLOW: 0,
    BLOCK: 0,
    REVIEW: 0,
    UNAUDITED: 0,
  }
  const bySourceKind: Record<LegacyMediaSourceKind, number> = {
    LISTING: 0,
    REVIEW: 0,
    CHAT: 0,
  }
  const byPublicVisibility: Record<LegacyMediaPublicVisibility, number> = {
    PUBLIC_DIRECT: 0,
    LEGACY_PROXY: 0,
    PRIVATE_PROXY: 0,
    PRIVATE: 0,
  }

  let total = 0
  const resultRows = [...rows].map((raw) => {
    // `db.execute` 的泛型只约束调用侧返回形状，不参与 map 的入参推断，这里显式收窄。
    const row = raw as unknown as {
      source_kind: LegacyMediaSourceKind
      audit_status: LegacyMediaAuditStatus
      decision: LegacyMediaDecision | null
      public_visibility: LegacyMediaPublicVisibility
      count: number
    }
    total += row.count
    byStatus[row.audit_status] += row.count
    byDecision[row.decision ?? 'UNAUDITED'] += row.count
    bySourceKind[row.source_kind] += row.count
    byPublicVisibility[row.public_visibility] += row.count
    return {
      sourceKind: row.source_kind,
      auditStatus: row.audit_status,
      decision: row.decision,
      publicVisibility: row.public_visibility,
      count: row.count,
    }
  })

  return { total, byStatus, byDecision, bySourceKind, byPublicVisibility, rows: resultRows }
}

export type LegacyMediaAuditCandidate = {
  objectKey: string
  sourceKind: LegacyMediaSourceKind
}

/** 取一批待补审对象；`next_attempt_at` 未到或重试耗尽的不会出现。 */
export async function listLegacyMediaAuditCandidates(
  db: Db,
  input: { limit: number; maxAttempts?: number },
): Promise<LegacyMediaAuditCandidate[]> {
  const limit = Math.min(Math.max(1, Math.trunc(input.limit)), 100)
  const maxAttempts = input.maxAttempts ?? DEFAULT_AUDIT_MAX_ATTEMPTS
  const rows = await db.execute<{ object_key: string; source_kind: LegacyMediaSourceKind }>(sql`
    SELECT object_key, source_kind
    FROM legacy_media_audit_items
    WHERE audit_status = 'PENDING'
      AND attempts < ${maxAttempts}
      AND next_attempt_at <= now()
    ORDER BY next_attempt_at, created_at, object_key
    LIMIT ${limit}
  `)
  return [...rows].map((row) => ({ objectKey: row.object_key, sourceKind: row.source_kind }))
}

export async function findLegacyMediaAuditItem(
  db: Db,
  objectKey: string,
): Promise<LegacyMediaAuditItem | null> {
  const [row] = await db
    .select()
    .from(legacyMediaAuditItems)
    .where(eq(legacyMediaAuditItems.objectKey, objectKey))
    .limit(1)
  return row ?? null
}

export async function markLegacyMediaAuditFailure(
  db: Db,
  input: {
    objectKey: string
    error: string
    retryable: boolean
    maxAttempts?: number
    retryDelayMs?: number
  },
): Promise<{ attempts: number; auditStatus: LegacyMediaAuditStatus } | null> {
  const maxAttempts = input.maxAttempts ?? DEFAULT_AUDIT_MAX_ATTEMPTS
  const retryDelayMs = Math.max(0, input.retryDelayMs ?? 60_000)
  const lastError = input.error.slice(0, 500)
  const rows = await db.execute<{ attempts: number; audit_status: LegacyMediaAuditStatus }>(sql`
    UPDATE legacy_media_audit_items
    SET
      attempts = attempts + 1,
      last_error = ${lastError},
      last_attempt_at = now(),
      audit_status = CASE
        WHEN ${input.retryable} AND attempts + 1 < ${maxAttempts}
          THEN 'PENDING'::legacy_media_audit_status
        ELSE 'FAILED'::legacy_media_audit_status
      END,
      next_attempt_at = CASE
        WHEN ${input.retryable} AND attempts + 1 < ${maxAttempts}
          THEN now() + (${retryDelayMs}::int * interval '1 millisecond')
        ELSE now()
      END,
      updated_at = now()
    WHERE object_key = ${input.objectKey}
      AND audit_status <> 'AUDITED'
    RETURNING attempts, audit_status
  `)
  const [row] = [...rows]
  return row ? { attempts: row.attempts, auditStatus: row.audit_status } : null
}

export type FinalizeLegacyMediaAuditInput = {
  objectKey: string
  sourceKind: LegacyMediaSourceKind
  decision: LegacyMediaDecision
  provider: string | null
  providerRequestId: string | null
  policyVersion: string | null
  suggestion: string | null
  label: string | null
  subLabel: string | null
  score: number | null
  contentDigest: string
  sizeBytes: number
  mimeType: string
  now?: Date
}

export type FinalizeLegacyMediaAuditResult = {
  status: 'audited' | 'already_audited' | 'missing'
  decision: LegacyMediaDecision | null
  listingsAffected: number
}

/**
 * 写入补审结论，并在事务内落实可见性收口：
 * - `REVIEW`：所有引用该对象的商品置 `moderation_status='REVIEW'`，并补一条
 *   `listing_moderation_records`（管理端待审队列按「REVIEW 状态 + 最新 REVIEW 记录」取数，
 *   少这条不会进队）。
 * - `BLOCK`：商品置 `BLOCKED`，同样留审核记录；不删图片、不删对象。
 * - `ALLOW`：不动商品可见性。
 *
 * 人工治理下架（`governance_delisted_at`）的商品不参与改判，保留治理状态。
 */
export async function finalizeLegacyMediaAudit(
  db: Db,
  input: FinalizeLegacyMediaAuditInput,
): Promise<FinalizeLegacyMediaAuditResult> {
  const now = input.now ?? new Date()

  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(legacyMediaAuditItems)
      .where(eq(legacyMediaAuditItems.objectKey, input.objectKey))
      .for('update')
    if (!locked) {
      return { status: 'missing' as const, decision: null, listingsAffected: 0 }
    }
    if (locked.auditStatus === 'AUDITED') {
      return { status: 'already_audited' as const, decision: locked.decision, listingsAffected: 0 }
    }

    await tx
      .update(legacyMediaAuditItems)
      .set({
        auditStatus: 'AUDITED',
        decision: input.decision,
        provider: input.provider,
        providerRequestId: input.providerRequestId,
        policyVersion: input.policyVersion,
        suggestion: input.suggestion,
        label: input.label,
        subLabel: input.subLabel,
        score: input.score,
        contentDigest: input.contentDigest,
        sizeBytes: input.sizeBytes,
        mimeType: input.mimeType,
        attempts: locked.attempts + 1,
        lastError: null,
        lastAttemptAt: now,
        nextAttemptAt: now,
        auditedAt: now,
        updatedAt: now,
      })
      .where(eq(legacyMediaAuditItems.id, locked.id))

    if (input.decision === 'ALLOW' || input.sourceKind !== 'LISTING') {
      return { status: 'audited' as const, decision: input.decision, listingsAffected: 0 }
    }

    const affected = await tx
      .selectDistinct({
        id: listings.id,
        sellerId: listings.sellerId,
        title: listings.title,
        description: listings.description,
        status: listings.status,
        moderationStatus: listings.moderationStatus,
      })
      .from(listingImages)
      .innerJoin(listings, eq(listings.id, listingImages.listingId))
      .where(
        and(eq(listingImages.objectKey, input.objectKey), isNull(listings.governanceDelistedAt)),
      )

    const targetModerationStatus = input.decision === 'BLOCK' ? 'BLOCKED' : 'REVIEW'
    const moderationReason =
      input.decision === 'BLOCK' ? 'PROHIBITED_CONTENT' : 'CONTENT_REQUIRES_REVIEW'
    const ruleVersion = input.policyVersion ?? 'legacy-media-audit'
    let listingsAffected = 0

    for (const listing of affected) {
      if (listing.moderationStatus === 'BLOCKED' && targetModerationStatus === 'REVIEW') {
        continue
      }
      if (listing.moderationStatus !== targetModerationStatus) {
        await tx
          .update(listings)
          .set({
            moderationStatus: targetModerationStatus,
            moderationReason,
            moderationRuleVersion: ruleVersion,
            moderatedAt: now,
            updatedAt: now,
          })
          .where(eq(listings.id, listing.id))
        listingsAffected += 1
      }
      await tx.insert(listingModerationRecords).values({
        listingId: listing.id,
        sellerId: listing.sellerId,
        action: 'LEGACY_MEDIA_AUDIT',
        titleSnapshot: listing.title,
        descriptionSnapshot: listing.description,
        decision: input.decision,
        matchedRules: [],
        matchedTermsMasked: [],
        ruleVersion,
        priorListingStatus: listing.status,
        provider: input.provider,
        providerRequestId: input.providerRequestId,
        suggestion: input.suggestion,
        label: input.label,
        subLabel: input.subLabel,
        score: input.score,
        createdAt: now,
      })
    }

    return { status: 'audited' as const, decision: input.decision, listingsAffected }
  })
}

/**
 * 读侧收口：`PENDING` / `FAILED` 一律按 `REVIEW`（不可公开），`AUDITED` 用真实结论。
 * 不在返回 map 里的键 = 盘点尚未覆盖，调用方保留历史兼容行为。
 */
export async function loadLegacyMediaAuditDecisions(
  db: Db,
  objectKeys: readonly string[],
): Promise<Map<string, LegacyMediaDecision>> {
  if (objectKeys.length === 0) return new Map()
  const rows = await db
    .select({
      objectKey: legacyMediaAuditItems.objectKey,
      auditStatus: legacyMediaAuditItems.auditStatus,
      decision: legacyMediaAuditItems.decision,
    })
    .from(legacyMediaAuditItems)
    .where(inArray(legacyMediaAuditItems.objectKey, [...objectKeys]))

  const decisions = new Map<string, LegacyMediaDecision>()
  for (const row of rows) {
    if (row.auditStatus === 'AUDITED' && row.decision) {
      decisions.set(row.objectKey, row.decision)
    } else {
      decisions.set(row.objectKey, 'REVIEW')
    }
  }
  return decisions
}

/**
 * 匿名旧图代理的单键判断。没盘点到的键保持历史可读；盘点到的只有 `AUDITED + ALLOW` 可读。
 * 查询失败时 fail-closed（false）。
 */
export async function isLegacyMediaPubliclyReadable(db: Db, objectKey: string): Promise<boolean> {
  try {
    const item = await findLegacyMediaAuditItem(db, objectKey)
    if (!item) return true
    return item.auditStatus === 'AUDITED' && item.decision === 'ALLOW'
  } catch {
    return false
  }
}

/**
 * 授权读者的单键判断（审查 P1-1）。
 *
 * `isLegacyMediaPubliclyReadable` 只回答「这个对象能不能对**匿名**公开」；卖家本人、管理员、
 * 订单/纠纷当事人本来就能在各自页面拿到同一张图的旧 URL，按库存状态一律 404 会误伤他们
 * （见 `listings/service.ts`、`admin/service.ts`、`transactions/service.ts` 的旧键输出）。
 *
 * 这里只按 `listing_images.object_key` 关联业务关系，不信任请求方自报的身份：
 * 调用方必须先用会话解析出 `viewerId`。查询失败 fail-closed。
 */
export async function isLegacyMediaReadableByViewer(
  db: Db,
  objectKey: string,
  viewerId: string,
): Promise<boolean> {
  try {
    const rows = await db.execute<{ allowed: number }>(sql`
      SELECT 1 AS allowed
      FROM ${users} AS u
      WHERE u.id = ${viewerId}::uuid
        AND (
          u.role = 'ADMIN'
          OR EXISTS (
            SELECT 1
            FROM ${listingImages} AS li
            JOIN ${listings} AS l ON l.id = li.listing_id
            WHERE li.object_key = ${objectKey}
              AND l.seller_id = ${viewerId}::uuid
          )
          OR EXISTS (
            SELECT 1
            FROM ${listingImages} AS li
            JOIN ${transactions} AS t ON t.listing_id = li.listing_id
            WHERE li.object_key = ${objectKey}
              AND (t.buyer_id = ${viewerId}::uuid OR t.seller_id = ${viewerId}::uuid)
          )
          OR EXISTS (
            SELECT 1
            FROM ${listingImages} AS li
            JOIN ${transactions} AS t ON t.listing_id = li.listing_id
            JOIN ${disputes} AS d ON d.transaction_id = t.id
            WHERE li.object_key = ${objectKey}
              AND (d.initiator_id = ${viewerId}::uuid OR d.respondent_id = ${viewerId}::uuid)
          )
        )
      LIMIT 1
    `)
    return [...rows].length > 0
  } catch {
    return false
  }
}

/**
 * 运维重排（审查 P1-5）：把重试耗尽的 `FAILED` 行重置为 `PENDING`，让 worker 下一轮重新处理。
 *
 * - `limit`：本次最多重排多少行（默认 100，上限 1000），避免一次把整表拉回队列。
 * - `before`：只重排 `last_attempt_at` 早于该时刻的行（默认不限），用于「修好配置后只重排旧失败」。
 *
 * `attempts` 归零是刻意的：不归零的话 `attempts < maxAttempts` 仍然不成立，下一轮永远选不到。
 * 不会碰 `AUDITED` 行，也不会改动 `decision` —— 可见性仍按重审后的新结论决定。
 */
export async function requeueFailedLegacyMediaAudit(
  db: Db,
  options: { limit?: number; before?: Date | null } = {},
): Promise<{ requeued: number }> {
  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 100)), 1000)
  const before = options.before ?? null
  const rows = await db.execute<{ id: string }>(sql`
    WITH picked AS (
      SELECT id
      FROM legacy_media_audit_items
      WHERE audit_status = 'FAILED'
        AND (${before}::timestamptz IS NULL OR last_attempt_at < ${before})
      ORDER BY last_attempt_at NULLS FIRST, object_key
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE legacy_media_audit_items AS item
    SET
      audit_status = 'PENDING',
      attempts = 0,
      last_error = NULL,
      next_attempt_at = now(),
      updated_at = now()
    FROM picked
    WHERE item.id = picked.id
    RETURNING item.id
  `)
  return { requeued: [...rows].length }
}
