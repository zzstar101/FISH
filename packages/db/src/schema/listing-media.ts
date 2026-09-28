import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { createdAt, primaryKey } from './common'
import { moderationDecisionEnum } from './moderation'
import { users } from './users'

/**
 * 图片 staging → IMS → 固化 final 的落库记录（#286）。
 *
 * 一行 = 「某个 staging 对象在当前字节内容下的一次审核结论」。`staging_key` 会随 PUT 覆盖而指向
 * 不同内容，所以归属/幂等必须带 `content_digest`（本地 sha256，对**确认时刻实际读到的全量字节**
 * 计算）——同一个 staging 键换了内容就是新的一行，旧结论不会被复用。
 *
 * `final_key` 是服务端生成的**当前可引用键**，取值随结论而定：机器 `ALLOW` 直接是公开的
 * `listings/…` 快照；`REVIEW` 是私有前缀 `listing-review-media/…` 下的不可变快照（人工审核前
 * 不进匿名可读的位置）；`BLOCK` 不固化（保持 NULL），因此「被阻断的图」不可能出现在
 * `listings/` 前缀下，也不可能被 Listing 引用。
 *
 * `settled_decision` / `settled_at` 是**人工结算**（#286 复审 blocker 1）：`moderation_decision`
 * 是机器的原始结论、不可变；管理员对商品做出 `ALLOW`/`BLOCK` 时，这张 REVIEW 图在同一事务里
 * 被结算，之后编辑重算结论要读的是 `settled_decision ?? moderation_decision`。没有这两列时，
 * 一次不改图的纯文本编辑会把已人工放行的商品按原始 REVIEW 重新压回人工队列。
 */
export const listingMediaObjects = pgTable(
  'listing_media_objects',
  {
    ...primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    stagingKey: text('staging_key').notNull(),
    finalKey: text('final_key'),
    /** 本地 sha256（64 位小写十六进制），参与幂等键，也是「内容未被替换」的比对依据。 */
    contentDigest: text('content_digest').notNull(),
    /** 审核上游返回的内容摘要（腾讯 `FileMD5`）；provider 未返回时为 NULL。 */
    providerMd5: text('provider_md5'),
    moderationDecision: moderationDecisionEnum('moderation_decision').notNull(),
    /** 人工结算结论（管理员对商品的 ALLOW/BLOCK）；NULL = 尚未结算，仍以机器结论为准。 */
    settledDecision: moderationDecisionEnum('settled_decision'),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    provider: text('provider').notNull(),
    providerRequestId: text('provider_request_id'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('listing_media_objects_idempotency_uq').on(
      table.userId,
      table.stagingKey,
      table.contentDigest,
    ),
    uniqueIndex('listing_media_objects_final_key_uq').on(table.finalKey),
    index('listing_media_objects_user_id_created_at_idx').on(table.userId, table.createdAt),
    check(
      'listing_media_objects_staging_key_prefix',
      sql`${table.stagingKey} LIKE 'listing-media/%'`,
    ),
    check(
      'listing_media_objects_content_digest_sha256',
      sql`${table.contentDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'listing_media_objects_provider_md5_shape',
      sql`${table.providerMd5} IS NULL OR ${table.providerMd5} ~ '^[0-9a-f]{32}$'`,
    ),
    check(
      'listing_media_objects_final_key_required',
      sql`(${table.moderationDecision} = 'BLOCK') OR (${table.finalKey} IS NOT NULL)`,
    ),
    check(
      'listing_media_objects_provider_known',
      sql`${table.provider} IN ('LOCAL', 'TENCENT_IMS')`,
    ),
    check(
      'listing_media_objects_settled_pair',
      sql`(${table.settledDecision} IS NULL AND ${table.settledAt} IS NULL)
          OR (${table.settledDecision} IS NOT NULL AND ${table.settledAt} IS NOT NULL)`,
    ),
    check(
      'listing_media_objects_settled_review_only',
      sql`${table.settledDecision} IS NULL OR ${table.moderationDecision} = 'REVIEW'`,
    ),
  ],
)
