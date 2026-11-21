import { sql } from 'drizzle-orm'
import {
  check,
  doublePrecision,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { createdAt, primaryKey } from './common'
import { listingStatusEnum, listings } from './listings'
import { users } from './users'

export const moderationDecisionEnum = pgEnum('moderation_decision', ['ALLOW', 'BLOCK', 'REVIEW'])

/**
 * 商品文本审核记录（`listing_moderation_records`）。
 *
 * `provider* / suggestion / label / subLabel / score` 是 #228 的**可追溯字段**：本地词表
 * 时代只记命中规则，接腾讯 TMS 后必须能回答「这次判定来自哪个 provider、哪次请求、上游给了
 * 什么标签与置信度」。列可空是为了兼容 #228 之前的历史行（那时没有这些概念）。
 *
 * `ruleVersion` 复用为**策略版本**：本地是 `MODERATION_RULE_VERSION`，腾讯是 `BizType`。
 * 这些字段只供审计与人工复核，**不向普通用户暴露**（#228）。
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
    /**
     * `Pass | Review | Block`，含义随 `provider` 变化：`TENCENT_*` 是腾讯原始结论，
     * `LOCAL` 由本地 `decision` 派生（见 `apps/api/src/modules/moderation/providers/local.ts`），
     * 人工改判为 NULL。读之前必须先看 `provider`，不要一律当成腾讯结论。
     */
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

/**
 * 多模态模型二次审核记录。
 *
 * **为什么不塞进 `listing_moderation_records`**：那张表的 `provider` CHECK 只允许
 * `LOCAL / TENCENT_TMS / TENCENT_IMS / MANUAL`，一行描述的是「某次内容安全判定」；
 * 模型是**决策层**的一环（判断腾讯的 REVIEW 在二手场景下是否真的违规），不是第三家内容安全
 * 供应商，混进去会让审计口径含糊。这里一行 = 一次模型复核，`moderationRecordId` 指回它复核的
 * 腾讯那行（该行被删时置空，历史复核仍保留）。
 *
 * `outcome` 记录这次复核**实际造成了什么**：`SHADOW`（影子期只记不生效）、`AUTO_PASSED`、
 * `AUTO_REJECTED`、`PENDING`（模型没把握/出错，留给人工）。人工最终怎么判不复制到这里 ——
 * 商品当前的 `moderation_status` 才是终局，用它与 `decision` 对比即可看出模型是否被推翻。
 */
export const moderationModelReviewDecisionEnum = pgEnum('moderation_model_review_decision', [
  'PASS',
  'BLOCK',
  'UNSURE',
  'ERROR',
])

export const moderationModelReviewOutcomeEnum = pgEnum('moderation_model_review_outcome', [
  'SHADOW',
  'AUTO_PASSED',
  'AUTO_REJECTED',
  'PENDING',
])

export const moderationModelReviews = pgTable(
  'moderation_model_reviews',
  {
    ...primaryKey(),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    moderationRecordId: uuid('moderation_record_id').references(() => listingModerationRecords.id, {
      onDelete: 'set null',
    }),
    /** 上游模型名（如 `DeepSeek-V4.1-Flash`）：换模型后旧记录仍能解释当时的行为。 */
    model: text('model').notNull(),
    /** 提示词版本：改提示词必须递增，否则同一条商品的复核会被唯一索引当成重复。 */
    promptVersion: text('prompt_version').notNull(),
    /** 送审内容的 sha256（标题/描述/图片键/腾讯标签），用于判断两次复核的输入是否相同。 */
    inputDigest: text('input_digest').notNull(),
    decision: moderationModelReviewDecisionEnum('decision').notNull(),
    /** 模型给出的风险类别（自由文本，仅后台可见）。 */
    category: text('category'),
    /** 模型给出的判定理由（自由文本，仅后台可见；用户侧只显示固定话术）。 */
    reason: text('reason').notNull(),
    /** 模型引用的具体证据（原文摘录/图片描述），仅后台可见。 */
    evidence: jsonb('evidence').$type<string[]>().notNull(),
    confidence: doublePrecision('confidence'),
    latencyMs: integer('latency_ms').notNull(),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    outcome: moderationModelReviewOutcomeEnum('outcome').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    // 幂等：job 重试或重复投递时，同一 (商品, 提示词版本, 模型) 只落一行。
    uniqueIndex('moderation_model_reviews_listing_prompt_model_uq').on(
      table.listingId,
      table.promptVersion,
      table.model,
    ),
    check(
      'moderation_model_reviews_confidence_range',
      sql`${table.confidence} IS NULL OR (${table.confidence} >= 0 AND ${table.confidence} <= 1)`,
    ),
  ],
)
