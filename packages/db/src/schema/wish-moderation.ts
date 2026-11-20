import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from './common'
import { moderationDecisionEnum } from './moderation'
import { users } from './users'
import { wishes } from './wishes'

/**
 * 许愿墙待审记录（#694 M5）。每次进入人工复审写入一条，绑定 `content_version`；
 * 管理员放行/拒绝只改这条记录与愿望行的对应版本，重复提交按终态幂等。
 */
export const wishModerationRecords = pgTable(
  'wish_moderation_records',
  {
    ...primaryKey(),
    wishId: uuid('wish_id')
      .notNull()
      .references(() => wishes.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 送审内容对应的公开版本：新建待审为 1；编辑待审为 current content_version + 1。 */
    contentVersion: integer('content_version').notNull(),
    /** 送审内容快照（keyword / description），结算时按它写回。 */
    payload: jsonb('payload').notNull(),
    machineDecision: moderationDecisionEnum('machine_decision').notNull(),
    decision: moderationDecisionEnum('decision').notNull(),
    status: text('status').notNull().default('PENDING'),
    provider: text('provider').notNull(),
    providerRequestId: text('provider_request_id'),
    policyVersion: text('policy_version').notNull(),
    suggestion: text('suggestion').notNull(),
    label: text('label'),
    subLabel: text('sub_label'),
    score: integer('score'),
    matchedRules: jsonb('matched_rules').notNull().default(sql`'[]'::jsonb`),
    matchedTermsMasked: jsonb('matched_terms_masked').notNull().default(sql`'[]'::jsonb`),
    reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewNote: text('review_note'),
    version: integer('version').notNull().default(0),
    ...timestamps(),
  },
  (table) => [
    check('wish_moderation_status_check', sql`${table.status} IN ('PENDING', 'SETTLED')`),
    check(
      'wish_moderation_provider_check',
      sql`${table.provider} IN ('LOCAL', 'TENCENT_TMS', 'TENCENT_IMS')`,
    ),
    check(
      'wish_moderation_suggestion_check',
      sql`${table.suggestion} IN ('Pass', 'Review', 'Block')`,
    ),
    check('wish_moderation_decision_check', sql`${table.decision} IN ('ALLOW', 'BLOCK', 'REVIEW')`),
    check(
      'wish_moderation_score_check',
      sql`${table.score} IS NULL OR (${table.score} >= 0 AND ${table.score} <= 100)`,
    ),
    uniqueIndex('wish_moderation_wish_content_version_uq').on(table.wishId, table.contentVersion),
    index('wish_moderation_status_created_at_idx').on(table.status, table.createdAt),
  ],
)
