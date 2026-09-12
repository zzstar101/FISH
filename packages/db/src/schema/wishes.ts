import { sql } from 'drizzle-orm'
import { boolean, check, index, integer, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from './common'
import { listingCategoryEnum } from './listings'
import { users } from './users'

export const wishStatusEnum = pgEnum('wish_status', ['ACTIVE', 'FULFILLED', 'CLOSED'])

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
  ],
)
