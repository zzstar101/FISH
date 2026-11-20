import { sql } from 'drizzle-orm'
import {
  check,
  doublePrecision,
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
import { transactions } from './transactions'
import { users } from './users'

/**
 * 交易评价图片审核记录（`review_moderation_records`，#694 M5c）。
 *
 * 一行 = 「某个 staging 对象在当前字节内容下的一次 IMS 审核结论」。
 * `staging_key` 会被 PUT 覆盖，因此幂等键必须带 `content_digest`（对确认时刻**实际读到的
 * 全量字节**计算的 sha256）——换内容就是新的一行，旧结论不会被复用，也就挡住了
 * 「确认后被替换成另一张图」的 TOCTOU。
 *
 * `final_key` 是服务端生成的**当前可引用键**：
 * - 机器 `ALLOW` → 公开的 `reviews/{usr}/{med}.{ext}`，评价可引用、任何人都能读；
 * - 机器 `REVIEW` → 私有 `review-moderation-media/{usr}/{med}.{ext}`，只给作者本人与管理员
 *   读取，评价对外隐藏，等管理员放行；
 * - 机器 `BLOCK` → 保持 NULL，**不产生任何 final 键**，因此被阻断的图既不会出现在公开前缀，
 *   也不可能被评价引用。
 *
 * `settled_decision` 是人工放行/拒绝后的终态（幂等键仍是机器结论）：放行时把字节从私有键
 * 搬到公开键，并在同一事务里改写 `transaction_review_images.object_key`；拒绝则保留私有键，
 * 评价永久不对外展示。读取时一律用 `settled_decision ?? moderation_decision`。
 */
export const reviewModerationRecords = pgTable(
  'review_moderation_records',
  {
    ...primaryKey(),
    /** 评价作者：staging 键、final 键都必须落在这个用户名下。 */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** 图片挂在哪笔交易上：确认时由服务端从交易参与者关系推导，不信任客户端。 */
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => transactions.id),
    stagingKey: text('staging_key').notNull(),
    finalKey: text('final_key'),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    /** 本地 sha256（64 位小写十六进制），参与幂等键，也是「字节未被替换」的比对依据。 */
    contentDigest: text('content_digest').notNull(),
    /** IMS 返回的内容摘要（腾讯 `FileMD5`）；provider 未返回时为 NULL。 */
    providerMd5: text('provider_md5'),
    moderationDecision: moderationDecisionEnum('moderation_decision').notNull(),
    settledDecision: moderationDecisionEnum('settled_decision'),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    provider: text('provider').notNull(),
    providerRequestId: text('provider_request_id'),
    /** 策略版本：腾讯是 BizType，本地是 `MODERATION_RULE_VERSION`。 */
    policyVersion: text('policy_version').notNull(),
    /** 实际送审的 IMS BizType；本地审核为 NULL，便于事后区分策略号。 */
    bizType: text('biz_type'),
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
    uniqueIndex('review_moderation_records_idempotency_uq').on(
      table.userId,
      table.stagingKey,
      table.contentDigest,
    ),
    uniqueIndex('review_moderation_records_final_key_uq').on(table.finalKey),
    // 管理端待审列表：未结算 + 机器 REVIEW，按时间排队。
    index('review_moderation_records_pending_idx').on(
      table.settledDecision,
      table.moderationDecision,
      table.createdAt,
    ),
    check(
      'review_moderation_records_staging_key_prefix',
      sql`${table.stagingKey} LIKE 'transaction-review-media/%'`,
    ),
    check(
      'review_moderation_records_content_digest_sha256',
      sql`${table.contentDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'review_moderation_records_provider_md5_shape',
      sql`${table.providerMd5} IS NULL OR ${table.providerMd5} ~ '^[0-9a-f]{32}$'`,
    ),
    check('review_moderation_records_size_positive', sql`${table.sizeBytes} > 0`),
    check(
      'review_moderation_records_final_key_required',
      sql`(${table.moderationDecision} = 'BLOCK') OR (${table.finalKey} IS NOT NULL)`,
    ),
    check(
      'review_moderation_records_final_key_prefix',
      sql`${table.finalKey} IS NULL
          OR ${table.finalKey} LIKE 'reviews/%'
          OR ${table.finalKey} LIKE 'review-moderation-media/%'`,
    ),
    check(
      'review_moderation_records_provider_known',
      sql`${table.provider} IN ('LOCAL', 'TENCENT_IMS')`,
    ),
    check(
      'review_moderation_records_suggestion_known',
      sql`${table.suggestion} IS NULL OR ${table.suggestion} IN ('Pass', 'Review', 'Block')`,
    ),
    check(
      'review_moderation_records_score_range',
      sql`${table.score} IS NULL OR (${table.score} >= 0 AND ${table.score} <= 100)`,
    ),
    check(
      'review_moderation_records_settled_pair',
      sql`(${table.settledDecision} IS NULL AND ${table.settledAt} IS NULL)
          OR (${table.settledDecision} IS NOT NULL AND ${table.settledAt} IS NOT NULL)`,
    ),
    check(
      'review_moderation_records_settled_review_only',
      sql`${table.settledDecision} IS NULL OR ${table.moderationDecision} = 'REVIEW'`,
    ),
  ],
)
