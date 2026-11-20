import { sql } from 'drizzle-orm'
import {
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { primaryKey, timestamps, timestamptz } from './common'
import { moderationDecisionEnum } from './moderation'
import { users } from './users'

/**
 * #694 M8：存量图片补审。
 *
 * 一行 = 一个**对象键**（不是一条业务引用）。同一张图可能被多个商品 / 评价 / 消息引用，
 * 补审对象是对象本身，因此 `object_key` 唯一；业务引用放在 `source_refs` 里留痕。
 *
 * 只登记**当前审核链路没有结论**的历史对象：商品图没有 `listing_media_objects` 行、
 * 评价图没有 `review_moderation_records` 行、聊天图没有 `chat_moderation_records` 行。
 * 盘点本身只写本表，不改任何业务行。
 */
export const legacyMediaSourceKindEnum = pgEnum('legacy_media_source_kind', [
  'LISTING',
  'REVIEW',
  'CHAT',
])

/** 盘点时看到的公开读面。用来判断补审期间需要收口哪条路径。 */
export const legacyMediaPublicVisibilityEnum = pgEnum('legacy_media_public_visibility', [
  /** 对象存储匿名直读（商品图）。 */
  'PUBLIC_DIRECT',
  /** 旧 UUID 键，经 `/api/uploads/legacy/:token` 匿名代理读。 */
  'LEGACY_PROXY',
  /** 评价图，经签名代理读，仅登录可见。 */
  'PRIVATE_PROXY',
  /** 聊天图等仅参与者可读的对象。 */
  'PRIVATE',
])

export const legacyMediaAuditStatusEnum = pgEnum('legacy_media_audit_status', [
  /** 已盘点，等待补审；失败可重试时也留在此状态。 */
  'PENDING',
  /** 补审成功，`decision` 是最终结论。 */
  'AUDITED',
  /** 重试耗尽或上游明确拒绝，等待人工处理；读取面按不可见处理。 */
  'FAILED',
])

export type LegacyMediaSourceRef = {
  kind: 'LISTING' | 'REVIEW' | 'CHAT'
  sourceTable: string
  ownerUserId: string
  listingId?: string
  imageId?: string
  reviewId?: string
  transactionId?: string
  mediaId?: string
  messageId?: string
  conversationId?: string
}

export const legacyMediaAuditItems = pgTable(
  'legacy_media_audit_items',
  {
    ...primaryKey(),
    objectKey: text('object_key').notNull(),
    sourceKind: legacyMediaSourceKindEnum('source_kind').notNull(),
    sourceTable: text('source_table').notNull(),
    /** 全部引用（商品 / 评价 / 聊天），按 LISTING → REVIEW → CHAT 排序。 */
    sourceRefs: jsonb('source_refs').$type<LegacyMediaSourceRef[]>().notNull(),
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** 多个用户共用同一对象键时 > 1；管理员可据此判断跨用户共享的历史边界。 */
    ownerCount: integer('owner_count').notNull().default(1),
    referenceCount: integer('reference_count').notNull().default(1),
    listingReferenceCount: integer('listing_reference_count').notNull().default(0),
    publicVisibility: legacyMediaPublicVisibilityEnum('public_visibility').notNull(),
    /** 盘点时是否已有审核链路结论；NULL 表示正是本次要补的历史对象。 */
    existingDecision: moderationDecisionEnum('existing_decision'),
    auditStatus: legacyMediaAuditStatusEnum('audit_status').notNull().default('PENDING'),
    decision: moderationDecisionEnum('decision'),
    provider: text('provider'),
    providerRequestId: text('provider_request_id'),
    policyVersion: text('policy_version'),
    suggestion: text('suggestion'),
    label: text('label'),
    subLabel: text('sub_label'),
    score: doublePrecision('score'),
    /** 实际送审字节的 sha256；用于证明审的是哪一版对象。 */
    contentDigest: text('content_digest'),
    sizeBytes: integer('size_bytes'),
    mimeType: text('mime_type'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    lastAttemptAt: timestamptz('last_attempt_at'),
    nextAttemptAt: timestamptz('next_attempt_at').notNull().defaultNow(),
    auditedAt: timestamptz('audited_at'),
    /**
     * 人工复核的乐观并发版本（#694 审查 P1-2）：管理端队列读出它，提交决定时原样回传；
     * 期间被别人改过就 409，绝不用过期判断放行/拒绝。机器补审不碰它，人工决定 +1。
     */
    version: integer('version').notNull().default(0),
    /** 最后一次盘点命中时间；可重复盘点，不覆盖补审结论。 */
    inventoryUpdatedAt: timestamptz('inventory_updated_at').notNull().defaultNow(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('legacy_media_audit_items_object_key_uq').on(table.objectKey),
    index('legacy_media_audit_items_status_next_attempt_idx').on(
      table.auditStatus,
      table.nextAttemptAt,
    ),
    index('legacy_media_audit_items_source_kind_idx').on(table.sourceKind),
    index('legacy_media_audit_items_owner_user_id_idx').on(table.ownerUserId),
    check(
      'legacy_media_audit_items_object_key_shape',
      sql`char_length(${table.objectKey}) BETWEEN 1 AND 256`,
    ),
    check('legacy_media_audit_items_owner_count_positive', sql`${table.ownerCount} >= 1`),
    check(
      'legacy_media_audit_items_reference_count_consistent',
      sql`${table.referenceCount} >= 1 AND ${table.listingReferenceCount} >= 0 AND ${table.listingReferenceCount} <= ${table.referenceCount}`,
    ),
    check(
      'legacy_media_audit_items_provider_known',
      sql`${table.provider} IS NULL OR ${table.provider} IN ('LOCAL', 'TENCENT_IMS')`,
    ),
    check(
      'legacy_media_audit_items_suggestion_known',
      sql`${table.suggestion} IS NULL OR ${table.suggestion} IN ('Pass', 'Review', 'Block')`,
    ),
    check(
      'legacy_media_audit_items_score_range',
      sql`${table.score} IS NULL OR (${table.score} >= 0 AND ${table.score} <= 100)`,
    ),
    check(
      'legacy_media_audit_items_digest_shape',
      sql`${table.contentDigest} IS NULL OR ${table.contentDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'legacy_media_audit_items_audited_consistent',
      sql`${table.auditStatus} <> 'AUDITED' OR (${table.decision} IS NOT NULL AND ${table.auditedAt} IS NOT NULL)`,
    ),
    check('legacy_media_audit_items_attempts_non_negative', sql`${table.attempts} >= 0`),
    check('legacy_media_audit_items_version_non_negative', sql`${table.version} >= 0`),
  ],
)
