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
    /**
     * 语义分（#322 M3）：归一化到 0–100 的整数；**NULL = 这一行由 v1 算法算出**
     * （向量缺失/过期/模型不匹配，或该对拿不到 cosine），不是"语义为 0"。
     *
     * 可空而不是 `notNull().default(0)`：0 与"没有语义分"在报表和降级判断里含义相反，
     * 用默认值会把两种状态抹平（`packages/db/src/schema/matches.ts` 的 CHECK 允许 NULL 或 0–100）。
     */
    semanticScore: smallint('semantic_score'),
    /**
     * 这一行是哪一版算法算的（#322 M3）：1 = v1 三路权重，2 = v2 四路权重。
     *
     * NOT NULL DEFAULT 1：M3 迁移之前的历史行自动落到 v1，不需要数据回填；CHECK 只允许 1/2，
     * 与 `packages/contracts/src/matching/schema.ts` 的 `RANKING_VERSION_V1` / `RANKING_VERSION`
     * 一一对应（db 包不依赖 contracts，故此处写字面量，改动时两处同步）。
     */
    rankingVersion: smallint('ranking_version').notNull().default(1),
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
    // NULL（v1 行）或 0–100（v2 行）——"没有语义分"与"语义分是 0"必须分得开。
    check(
      'matches_semantic_score_range',
      sql`${table.semanticScore} IS NULL OR (${table.semanticScore} >= 0 AND ${table.semanticScore} <= 100)`,
    ),
    check('matches_ranking_version_known', sql`${table.rankingVersion} IN (1, 2)`),
  ],
)
