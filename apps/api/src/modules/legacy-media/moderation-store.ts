import type {
  LegacyMediaAuditDecision,
  LegacyMediaAuditMachineDecision,
  LegacyMediaAuditProvider,
  LegacyMediaAuditSourceKind,
  LegacyMediaAuditStatus,
  LegacyMediaAuditSuggestion,
  LegacyMediaAuditVisibility,
} from '@fish/contracts/legacy-media/moderation'
import type { Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { jsonParam } from '@fish/db/json'
import { adminAuditLogs } from '@fish/db/schema/admin'
import { legacyMediaAuditItems } from '@fish/db/schema/legacy-media-audit'
import { and, eq, sql } from 'drizzle-orm'
import { cursorCondition } from '../admin/cursor'

/** 管理端队列 / 详情一行（SQL 平铺结果，service 映射成契约）。 */
export interface LegacyMediaAuditItemRow {
  id: string
  sourceKind: LegacyMediaAuditSourceKind
  sourceTable: string
  ownerUserId: string | null
  ownerNickname: string | null
  listingId: string | null
  listingTitle: string | null
  listingStatus: string | null
  listingModerationStatus: string | null
  ownerCount: number
  referenceCount: number
  listingReferenceCount: number
  visibility: LegacyMediaAuditVisibility
  auditStatus: LegacyMediaAuditStatus
  decision: LegacyMediaAuditMachineDecision | null
  provider: LegacyMediaAuditProvider | null
  providerRequestId: string | null
  policyVersion: string | null
  suggestion: LegacyMediaAuditSuggestion | null
  label: string | null
  subLabel: string | null
  score: number | null
  contentType: string | null
  sizeBytes: number | null
  contentDigest: string | null
  attempts: number
  lastError: string | null
  auditedAt: string
  /** 微秒精度 ISO，只用于编码游标。 */
  auditedAtCursor: string
  version: number
  createdAt: string
}

export type LegacyMediaAuditDecideOutcome =
  | { outcome: 'not-found' }
  | { outcome: 'conflict'; reason: 'state' | 'version' }
  | { outcome: 'applied' | 'replayed'; version: number }

export interface LegacyMediaAuditStore {
  /** 人工队列：机器 REVIEW、已补审且仍待人工结论的记录。 */
  listReview(input: {
    before: { createdAt: string; id: string } | null
    limit: number
  }): Promise<LegacyMediaAuditItemRow[]>
  /** 详情 / 媒体读取：只对 AUDITED 记录开放（含已被人工 BLOCK 的，P1-3 要能恢复）。 */
  findAudited(itemId: string): Promise<LegacyMediaAuditItemRow | null>
  findMedia(
    itemId: string,
  ): Promise<{ objectKey: string; contentType: string; sizeBytes: number } | null>
  decide(input: {
    itemId: string
    decision: LegacyMediaAuditDecision
    reason: string
    version: number
    actorUserId: string
  }): Promise<LegacyMediaAuditDecideOutcome>
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

/** 时间戳取毫秒 ISO 进契约、微秒 ISO 进游标（与评价队列同一手法）。 */
const ITEM_COLUMNS = sql`
  i.id,
  i.source_kind,
  i.source_table,
  i.owner_user_id,
  i.owner_count,
  i.reference_count,
  i.listing_reference_count,
  i.public_visibility,
  i.audit_status,
  i.decision,
  i.provider,
  i.provider_request_id,
  i.policy_version,
  i.suggestion,
  i.label,
  i.sub_label,
  i.score,
  i.mime_type,
  i.size_bytes,
  i.content_digest,
  i.attempts,
  i.last_error,
  i.version,
  u.nickname AS owner_nickname,
  l.id AS listing_id,
  l.title AS listing_title,
  l.status AS listing_status,
  l.moderation_status AS listing_moderation_status,
  to_char(i.audited_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS audited_at_iso,
  to_char(i.audited_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS audited_at_cursor,
  to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_iso`

/**
 * 商品来源的 `listingId` 只存在于第一条 ref（盘点 SQL 的 `jsonb_build_object` 形状），
 * 评价 / 聊天来源没有该字段，`listing` 在契约里就是 null。
 */
const ITEM_JOINS = sql`
  LEFT JOIN users u ON u.id = i.owner_user_id
  LEFT JOIN listings l
    ON i.source_kind = 'LISTING'
   AND l.id = (i.source_refs->0->>'listingId')::uuid`

function toItemRow(row: Record<string, unknown>): LegacyMediaAuditItemRow {
  return {
    id: String(row.id),
    sourceKind: row.source_kind as LegacyMediaAuditSourceKind,
    sourceTable: String(row.source_table),
    ownerUserId: nullableString(row.owner_user_id),
    ownerNickname: nullableString(row.owner_nickname),
    listingId: nullableString(row.listing_id),
    listingTitle: nullableString(row.listing_title),
    listingStatus: nullableString(row.listing_status),
    listingModerationStatus: nullableString(row.listing_moderation_status),
    ownerCount: Number(row.owner_count),
    referenceCount: Number(row.reference_count),
    listingReferenceCount: Number(row.listing_reference_count),
    visibility: row.public_visibility as LegacyMediaAuditVisibility,
    auditStatus: row.audit_status as LegacyMediaAuditStatus,
    decision: (row.decision as LegacyMediaAuditMachineDecision | null) ?? null,
    provider: (row.provider as LegacyMediaAuditProvider | null) ?? null,
    providerRequestId: nullableString(row.provider_request_id),
    policyVersion: nullableString(row.policy_version),
    suggestion: (row.suggestion as LegacyMediaAuditSuggestion | null) ?? null,
    label: nullableString(row.label),
    subLabel: nullableString(row.sub_label),
    score: row.score === null || row.score === undefined ? null : Number(row.score),
    contentType: nullableString(row.mime_type),
    sizeBytes:
      row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
    contentDigest: nullableString(row.content_digest),
    attempts: Number(row.attempts),
    lastError: nullableString(row.last_error),
    auditedAt: String(row.audited_at_iso),
    auditedAtCursor: String(row.audited_at_cursor),
    version: Number(row.version),
    createdAt: String(row.created_at_iso),
  }
}

/**
 * 存量图片补审的管理端读面（#694 审查 P1-2）。
 *
 * 队列只收 `AUDITED + REVIEW`：机器判 Block/Pass 的不需要人工重复判断；PENDING 的还在
 * worker 手里，FAILED 的走 CLI 重排（见 docs/legacy-media-audit.md），都不进人工队列。
 * 详情与媒体对**任意 AUDITED** 记录开放，所以被人工 BLOCK 的记录还能被找到并恢复。
 *
 * 决定只改审计结论与 `version`，不改对象键 / 不改 listing 状态：商品可见性由补审结论经
 * 现有读侧 gate 生效（§4），管理端商品审核则反过来同步审计行（P1-3）。
 */
export function createSqlLegacyMediaAuditStore(db: Db): LegacyMediaAuditStore {
  return {
    async listReview({ before, limit }) {
      const cursor = before ? cursorCondition(sql`i.audited_at`, sql`i.id`, before) : sql`TRUE`
      const rows = rowsOf(
        await db.execute(sql`
          SELECT ${ITEM_COLUMNS}
          FROM legacy_media_audit_items i
          ${ITEM_JOINS}
          WHERE i.audit_status = 'AUDITED'
            AND i.decision = 'REVIEW'
            AND ${cursor}
          ORDER BY i.audited_at DESC, i.id DESC
          LIMIT ${limit}
        `),
      )
      return rows.map(toItemRow)
    },

    async findAudited(itemId) {
      const rows = rowsOf(
        await db.execute(sql`
          SELECT ${ITEM_COLUMNS}
          FROM legacy_media_audit_items i
          ${ITEM_JOINS}
          WHERE i.id = ${itemId}::uuid
            AND i.audit_status = 'AUDITED'
          LIMIT 1
        `),
      )
      const row = rows[0]
      return row ? toItemRow(row) : null
    },

    async findMedia(itemId) {
      const rows = rowsOf(
        await db.execute(sql`
          SELECT object_key, mime_type, size_bytes
          FROM legacy_media_audit_items
          WHERE id = ${itemId}::uuid
            AND audit_status = 'AUDITED'
          LIMIT 1
        `),
      )
      const row = rows[0]
      if (!row) return null
      const contentType = nullableString(row.mime_type)
      const sizeBytes =
        row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes)
      if (!contentType || sizeBytes === null) return null
      return { objectKey: String(row.object_key), contentType, sizeBytes }
    },

    async decide({ itemId, decision, reason, version, actorUserId }) {
      return db.transaction(async (tx) => {
        const lockedRows = rowsOf(
          await tx.execute(sql`
            SELECT id, audit_status, decision, version
            FROM legacy_media_audit_items
            WHERE id = ${itemId}::uuid
            FOR UPDATE
          `),
        )
        const locked = lockedRows[0]
        if (!locked) return { outcome: 'not-found' } as const
        if (String(locked.audit_status) !== 'AUDITED') {
          return { outcome: 'conflict', reason: 'state' } as const
        }

        const currentDecision = locked.decision as LegacyMediaAuditMachineDecision | null
        const currentVersion = Number(locked.version)
        // 同结论重复提交是幂等的：不重复写审计，也不把版本再推一格。
        if (currentDecision === decision) {
          return { outcome: 'replayed', version: currentVersion } as const
        }
        if (currentVersion !== version) {
          return { outcome: 'conflict', reason: 'version' } as const
        }

        const [updated] = await tx
          .update(legacyMediaAuditItems)
          .set({
            decision,
            version: sql`${legacyMediaAuditItems.version} + 1`,
            updatedAt: sql`now()`,
          })
          .where(
            and(eq(legacyMediaAuditItems.id, itemId), eq(legacyMediaAuditItems.version, version)),
          )
          .returning({ version: legacyMediaAuditItems.version })
        if (!updated) return { outcome: 'conflict', reason: 'version' } as const

        await tx.insert(adminAuditLogs).values({
          id: newId(),
          actorUserId,
          action: 'LEGACY_MEDIA_AUDIT_DECISION',
          targetType: 'LEGACY_MEDIA_AUDIT_ITEM',
          targetId: itemId,
          // 不记对象键与图片字节：审计只要结论与可见性变化。
          before: jsonParam({
            status: 'AUDITED',
            decision: currentDecision,
            publicReadable: currentDecision === 'ALLOW',
            version: currentVersion,
          }),
          after: jsonParam({
            status: 'AUDITED',
            decision,
            publicReadable: decision === 'ALLOW',
            version: Number(updated.version),
          }),
          reason,
        })

        return { outcome: 'applied', version: Number(updated.version) } as const
      })
    },
  }
}
