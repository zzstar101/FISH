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

/**
 * 用户资料（昵称 / 个性签名 / 头像）待审记录（#694 M5）。
 *
 * 公开值仍然只落在 `users`（`nickname` / `signature` / `avatar_url`），所以列表、商品卡、
 * 聊天 sender、评价作者等所有投射天然同一口径——不需要在每个读路径上再过滤一遍
 * 「待审内容」；待审的新值只存在本表，管理员放行时才切到 `users`。
 *
 * `payload` **只记本次提交真正变化的列**（`nickname` / `signature` / `avatarUrl` 的子集）：
 * 放行时只写 payload 里出现的列，未提交的列保持库里现值，不会用提交时刻的旧快照覆盖
 * 并发改过的字段。`signature` 允许显式 `null`（清空签名），因此判定「这一列要不要写」
 * 必须用 `jsonb_exists(payload, 'signature')` 而不是取值是否为 NULL。
 */
export const profileModerationRecords = pgTable(
  'profile_moderation_records',
  {
    ...primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 送审内容快照：只含本次变化列。 */
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
    /** 乐观锁版本（#694 M5）：管理员决定必须带上读到的 version，避免重复放行。 */
    version: integer('version').notNull().default(0),
    ...timestamps(),
  },
  (table) => [
    check('profile_moderation_status_check', sql`${table.status} IN ('PENDING', 'SETTLED')`),
    check(
      'profile_moderation_provider_check',
      sql`${table.provider} IN ('LOCAL', 'TENCENT_TMS', 'TENCENT_IMS')`,
    ),
    check(
      'profile_moderation_suggestion_check',
      sql`${table.suggestion} IN ('Pass', 'Review', 'Block')`,
    ),
    check(
      'profile_moderation_decision_check',
      sql`${table.decision} IN ('ALLOW', 'BLOCK', 'REVIEW')`,
    ),
    check(
      'profile_moderation_score_check',
      sql`${table.score} IS NULL OR (${table.score} >= 0 AND ${table.score} <= 100)`,
    ),
    // 一个用户同时只有一份待审资料：新提交整体替换旧提交，不会出现两份"谁先放行谁生效"。
    uniqueIndex('profile_moderation_pending_user_uq')
      .on(table.userId)
      .where(sql`${table.status} = 'PENDING'`),
    index('profile_moderation_status_created_at_idx').on(table.status, table.createdAt),
  ],
)
