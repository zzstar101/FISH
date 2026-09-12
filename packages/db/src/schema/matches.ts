import { sql } from 'drizzle-orm'
import { check, index, integer, pgTable, smallint, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from './common'
import { listings } from './listings'
import { wishes } from './wishes'

/**
 * 商品 ↔ 愿望的匹配结果（#8 产出）。派生数据：父行消失即无意义，故 FK 为 CASCADE。
 * 行可变——#8 重算时 upsert 覆盖分数，因此保留 updated_at。
 */
export const matches = pgTable(
  'matches',
  {
    ...primaryKey(),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    wishId: uuid('wish_id')
      .notNull()
      .references(() => wishes.id, { onDelete: 'cascade' }),
    score: integer('score').notNull(),
    categoryScore: smallint('category_score').notNull(),
    keywordScore: smallint('keyword_score').notNull(),
    priceScore: smallint('price_score').notNull(),
    ...timestamps(),
  },
  (table) => [
    // 幂等键：#8 的 "同一 listing + wish 不重复"
    uniqueIndex('matches_listing_id_wish_id_uq').on(table.listingId, table.wishId),
    index('matches_wish_id_score_idx').on(table.wishId, table.score),
    check('matches_score_range', sql`${table.score} >= 0 AND ${table.score} <= 100`),
    check(
      'matches_category_score_range',
      sql`${table.categoryScore} >= 0 AND ${table.categoryScore} <= 100`,
    ),
    check(
      'matches_keyword_score_range',
      sql`${table.keywordScore} >= 0 AND ${table.keywordScore} <= 100`,
    ),
    check(
      'matches_price_score_range',
      sql`${table.priceScore} >= 0 AND ${table.priceScore} <= 100`,
    ),
  ],
)
