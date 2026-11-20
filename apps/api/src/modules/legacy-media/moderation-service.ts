import {
  type LegacyMediaAuditDecisionInput,
  LegacyMediaAuditDecisionResponseSchema,
  type LegacyMediaAuditErrorCode,
  type LegacyMediaAuditItem,
  LegacyMediaAuditItemSchema,
  type LegacyMediaAuditQueueQuery,
  LegacyMediaAuditQueueResponseSchema,
} from '@fish/contracts/legacy-media/moderation'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { decodeCursor, encodeCursor } from '../admin/cursor'
import type { LegacyMediaAuditItemRow, LegacyMediaAuditStore } from './moderation-store'

export class LegacyMediaAuditServiceError extends Error {
  constructor(
    readonly code: LegacyMediaAuditErrorCode,
    readonly status: 404 | 409 | 422 | 503,
    message: string,
  ) {
    super(message)
    this.name = 'LegacyMediaAuditServiceError'
  }
}

export interface LegacyMediaAuditService {
  list(
    query: LegacyMediaAuditQueueQuery,
  ): Promise<ReturnType<typeof LegacyMediaAuditQueueResponseSchema.parse>>
  detail(itemId: string): Promise<ReturnType<typeof LegacyMediaAuditItemSchema.parse> | null>
  decide(
    itemId: string,
    input: LegacyMediaAuditDecisionInput,
    actorUserId: string,
  ): Promise<ReturnType<typeof LegacyMediaAuditDecisionResponseSchema.parse>>
  findMedia(
    itemId: string,
  ): Promise<{ objectKey: string; contentType: string; sizeBytes: number } | null>
}

function toItem(row: LegacyMediaAuditItemRow): LegacyMediaAuditItem {
  return {
    id: encodePublicId(PUBLIC_ID_PREFIX.legacyMediaAuditItem, row.id),
    sourceKind: row.sourceKind,
    sourceTable: row.sourceTable,
    owner:
      row.ownerUserId && row.ownerNickname !== null
        ? {
            id: encodePublicId(PUBLIC_ID_PREFIX.user, row.ownerUserId),
            nickname: row.ownerNickname,
          }
        : null,
    listing:
      row.listingId &&
      row.listingTitle !== null &&
      row.listingStatus !== null &&
      row.listingModerationStatus !== null
        ? {
            id: encodePublicId(PUBLIC_ID_PREFIX.listing, row.listingId),
            title: row.listingTitle,
            status: row.listingStatus,
            moderationStatus: row.listingModerationStatus,
          }
        : null,
    counts: {
      owners: row.ownerCount,
      references: row.referenceCount,
      listings: row.listingReferenceCount,
    },
    visibility: row.visibility,
    media: {
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      contentDigest: row.contentDigest,
    },
    audit: {
      status: row.auditStatus,
      decision: row.decision,
      provider: row.provider,
      providerRequestId: row.providerRequestId,
      policyVersion: row.policyVersion,
      suggestion: row.suggestion,
      label: row.label,
      subLabel: row.subLabel,
      score: row.score,
      attempts: row.attempts,
      lastError: row.lastError,
      auditedAt: row.auditedAt,
    },
    version: row.version,
    createdAt: row.createdAt,
  }
}

/**
 * 存量图片补审的人工复核（#694 审查 P1-2 / P1-3）。
 *
 * 只做游标 / 枚举 / 公开 ID 映射与错误码收口；可见性由审计行的 `decision` 决定，读侧
 * gate 直接读同一行，所以这里不需要额外维护「哪些图现在可读」的派生状态。
 */
export function createLegacyMediaAuditService(options: {
  store: LegacyMediaAuditStore
}): LegacyMediaAuditService {
  const { store } = options
  return {
    async list(query) {
      const cursor = query.cursor
        ? decodeCursor(query.cursor, PUBLIC_ID_PREFIX.legacyMediaAuditItem)
        : null
      if (query.cursor && !cursor) {
        throw new LegacyMediaAuditServiceError(
          'LEGACY_MEDIA_AUDIT_INVALID_CURSOR',
          422,
          '分页游标无效',
        )
      }

      const rows = await store.listReview({ before: cursor, limit: query.limit + 1 })
      const hasMore = rows.length > query.limit
      const items = rows.slice(0, query.limit)
      const last = items[items.length - 1]
      return LegacyMediaAuditQueueResponseSchema.parse({
        items: items.map(toItem),
        nextCursor:
          hasMore && last
            ? encodeCursor(last.auditedAtCursor, last.id, PUBLIC_ID_PREFIX.legacyMediaAuditItem)
            : null,
      })
    },

    async detail(itemId) {
      const row = await store.findAudited(itemId)
      return row ? LegacyMediaAuditItemSchema.parse(toItem(row)) : null
    },

    async decide(itemId, input, actorUserId) {
      const result = await store.decide({
        itemId,
        decision: input.decision,
        reason: input.reason,
        version: input.version,
        actorUserId,
      })
      switch (result.outcome) {
        case 'not-found':
          throw new LegacyMediaAuditServiceError(
            'LEGACY_MEDIA_AUDIT_NOT_FOUND',
            404,
            '补审记录不存在',
          )
        case 'conflict':
          throw new LegacyMediaAuditServiceError(
            'LEGACY_MEDIA_AUDIT_CONFLICT',
            409,
            result.reason === 'version'
              ? '该记录已被他人处理，请刷新后重试'
              : '该记录当前不可人工处理',
          )
        case 'applied':
        case 'replayed':
          return LegacyMediaAuditDecisionResponseSchema.parse({
            id: encodePublicId(PUBLIC_ID_PREFIX.legacyMediaAuditItem, itemId),
            decision: input.decision,
            replayed: result.outcome === 'replayed',
            version: result.version,
          })
      }
    },

    async findMedia(itemId) {
      return store.findMedia(itemId)
    },
  }
}
