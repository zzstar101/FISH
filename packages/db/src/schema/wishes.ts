import { sql } from 'drizzle-orm'
import { boolean, check, index, integer, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from './common'
import { listingCategoryEnum } from './listings'
import { users } from './users'

export const wishStatusEnum = pgEnum('wish_status', ['ACTIVE', 'FULFILLED', 'CLOSED'])

/**
 * 公开可见性（#694 M5）：与愿望自身的 ACTIVE/FULFILLED/CLOSED 生命周期正交。
 * PENDING_REVIEW 只对作者本人与管理员可见，不进入需求池/匹配/向量 Job。
 */
export const wishModerationStatusEnum = pgEnum('wish_moderation_status', [
  'APPROVED',
  'PENDING_REVIEW',
  'REJECTED',
])

export const wishes = pgTable(
  'wishes',
  {
    ...primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    keyword: text('keyword').notNull(),
    /** 可空 = 不限分类；分类可空会给 #8 的 category 分项留一个分支，见 #8 的交接 TODO。 */
    category: listingCategoryEnum('category'),
    budgetMinCents: integer('budget_min_cents'),
    budgetMaxCents: integer('budget_max_cents'),
    description: text('description'),
    acceptSimilar: boolean('accept_similar').notNull().default(true),
    status: wishStatusEnum('status').notNull().default('ACTIVE'),
    moderationStatus: wishModerationStatusEnum('moderation_status').notNull().default('APPROVED'),
    /** 已公开内容的版本；每次 ALLOW 后的内容替换 +1，审核记录据此做 CAS。 */
    contentVersion: integer('content_version').notNull().default(1),
    /** 待人工放行的编辑（仅 REVIEW 编辑时写入；公开读侧永远读 keyword/description）。 */
    pendingKeyword: text('pending_keyword'),
    pendingDescription: text('pending_description'),
    pendingVersion: integer('pending_version'),
    ...timestamps(),
  },
  (table) => [
    check(
      'wishes_budget_min_cents_non_negative',
      sql`${table.budgetMinCents} IS NULL OR ${table.budgetMinCents} >= 0`,
    ),
    check(
      'wishes_budget_max_cents_non_negative',
      sql`${table.budgetMaxCents} IS NULL OR ${table.budgetMaxCents} >= 0`,
    ),
    check(
      'wishes_budget_range_ordered',
      sql`${table.budgetMinCents} IS NULL OR ${table.budgetMaxCents} IS NULL OR ${table.budgetMinCents} <= ${table.budgetMaxCents}`,
    ),
    index('wishes_status_category_idx').on(table.status, table.category),
    index('wishes_user_id_status_idx').on(table.userId, table.status),
    index('wishes_category_budget_max_cents_idx').on(table.category, table.budgetMaxCents),
    index('wishes_moderation_status_idx').on(table.moderationStatus),
  ],
)
