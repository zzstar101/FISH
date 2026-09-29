import { sql } from 'drizzle-orm'
import { check, doublePrecision, jsonb, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { createdAt, primaryKey } from './common'
import { listingStatusEnum, listings } from './listings'
import { users } from './users'

export const moderationDecisionEnum = pgEnum('moderation_decision', ['ALLOW', 'BLOCK', 'REVIEW'])

/**
 * 商品文本审核记录（`listing_moderation_records`）。
 *
 * `provider* / suggestion / label / subLabel / score` 是 #228 §6 的**可追溯字段**：本地词表
 * 时代只记命中规则，接腾讯 TMS 后必须能回答「这次判定来自哪个 provider、哪次请求、上游给了
 * 什么标签与置信度」。列可空是为了兼容 #228 之前的历史行（那时没有这些概念）。
 *
 * `ruleVersion` 复用为**策略版本**：本地是 `MODERATION_RULE_VERSION`，腾讯是 `BizType`。
 * 这些字段只供审计与人工复核，**不向普通用户暴露**（#228 §6）。
 */
export const listingModerationRecords = pgTable(
  'listing_moderation_records',
  {
    ...primaryKey(),
    listingId: uuid('listing_id').references(() => listings.id, { onDelete: 'set null' }),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => users.id),
    action: text('action').notNull(),
    titleSnapshot: text('title_snapshot').notNull(),
    descriptionSnapshot: text('description_snapshot').notNull(),
    decision: moderationDecisionEnum('decision').notNull(),
    matchedRules: jsonb('matched_rules').$type<string[]>().notNull(),
    matchedTermsMasked: jsonb('matched_terms_masked').$type<string[]>().notNull(),
    ruleVersion: text('rule_version').notNull(),
    priorListingStatus: listingStatusEnum('prior_listing_status'),
    /**
     * `LOCAL | TENCENT_TMS | TENCENT_IMS | MANUAL`；#228 之前的历史行为 NULL。
     *
     * 下面这组 provider 字段描述的是**文本**判定（本行快照就是 title/description）；`decision`
     * 是**整条商品**的聚合结论，可能被图片抬升（图片结论在 `listing_media_objects`）。因此
     * 「文本 Pass + 图片 Review」会落成 `decision=REVIEW, suggestion=Pass`，两者不矛盾。
     */
    provider: text('provider'),
    /** 腾讯 `RequestId`（已过白名单形状校验）；本地与人工结论为 NULL。 */
    providerRequestId: text('provider_request_id'),
    /** 腾讯 `Suggestion`（`Pass | Review | Block`）；本地与人工结论为 NULL。 */
    suggestion: text('suggestion'),
    label: text('label'),
    subLabel: text('sub_label'),
    /** 腾讯 `Score`：命中标签的模型置信度，仅审计/调参用，不参与判定。 */
    score: doublePrecision('score'),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      'listing_moderation_records_provider_known',
      sql`${table.provider} IS NULL OR ${table.provider} IN ('LOCAL', 'TENCENT_TMS', 'TENCENT_IMS', 'MANUAL')`,
    ),
    check(
      'listing_moderation_records_suggestion_known',
      sql`${table.suggestion} IS NULL OR ${table.suggestion} IN ('Pass', 'Review', 'Block')`,
    ),
    check(
      'listing_moderation_records_score_range',
      sql`${table.score} IS NULL OR (${table.score} >= 0 AND ${table.score} <= 100)`,
    ),
  ],
)
