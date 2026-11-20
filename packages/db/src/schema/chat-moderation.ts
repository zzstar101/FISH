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
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from './common'
import { conversations } from './conversations'
import { messages } from './messages'
import { moderationDecisionEnum } from './moderation'
import { users } from './users'

/** 与消息类型分开建模：聊天审核覆盖文本、图片、语音（#694 M1），但消息表只有一种。 */
export const chatModerationKindEnum = pgEnum('chat_moderation_kind', ['TEXT', 'IMAGE', 'VOICE'])

/** PENDING = 等人复核；SETTLED = 机器/人工已给出终局结论。 */
export const chatModerationStatusEnum = pgEnum('chat_moderation_status', ['PENDING', 'SETTLED'])

/**
 * 聊天审核记录（`chat_moderation_records`，#694 M1）。
 *
 * 一条消息最多一条记录（`message_id` 唯一）：文本在**写消息前**审核，结论与消息同事务落库；
 * 这样发送者的稳定状态、人工复核队列与审计都能从同一个 message id 对上。
 *
 * 审计字段照抄 `listingModerationRecords` 的口径：provider / provider_request_id /
 * policy_version（腾讯是 BizType，本地是词表版本）/ decision。`matched_*` 只存规则码与
 * 打码词，**不复制聊天正文**——管理员复核走消息行与媒体快照，日志不落正文。
 *
 * `machine_decision` 保留上游/词表的原始结论，`decision` 是当前有效结论（人工复核只改后者）；
 * `version` 供人工结算做 CAS，避免并发复核用旧结论覆盖新结论。
 */
export const chatModerationRecords = pgTable(
  'chat_moderation_records',
  {
    ...primaryKey(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    senderId: uuid('sender_id')
      .notNull()
      .references(() => users.id),
    kind: chatModerationKindEnum('kind').notNull(),
    /** 当前有效结论（人工复核可改判）。 */
    decision: moderationDecisionEnum('decision').notNull(),
    /** 机器/词表的原始结论，人工复核后保持不变。 */
    machineDecision: moderationDecisionEnum('machine_decision').notNull(),
    status: chatModerationStatusEnum('status').notNull(),
    provider: text('provider').notNull(),
    providerRequestId: text('provider_request_id'),
    /** 策略版本：腾讯是 BizType，本地是 `MODERATION_RULE_VERSION`。 */
    policyVersion: text('policy_version').notNull(),
    suggestion: text('suggestion'),
    label: text('label'),
    subLabel: text('sub_label'),
    score: doublePrecision('score'),
    matchedRules: jsonb('matched_rules').$type<string[]>().notNull(),
    matchedTermsMasked: jsonb('matched_terms_masked').$type<string[]>().notNull(),
    reviewedBy: uuid('reviewed_by').references(() => users.id),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewNote: text('review_note'),
    /** 人工结算 CAS 版本号；机器结论落库时为 0。 */
    version: integer('version').notNull().default(0),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('chat_moderation_records_message_id_uq').on(table.messageId),
    // 管理端待审列表：status = PENDING 按时间排队。
    index('chat_moderation_records_status_created_at_idx').on(table.status, table.createdAt),
    check(
      'chat_moderation_records_provider_known',
      sql`${table.provider} IN ('LOCAL', 'TENCENT_TMS', 'TENCENT_IMS')`,
    ),
    check(
      'chat_moderation_records_suggestion_known',
      sql`${table.suggestion} IS NULL OR ${table.suggestion} IN ('Pass', 'Review', 'Block')`,
    ),
    check(
      'chat_moderation_records_score_range',
      sql`${table.score} IS NULL OR (${table.score} >= 0 AND ${table.score} <= 100)`,
    ),
  ],
)
