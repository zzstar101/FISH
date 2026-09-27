import { index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { createdAt, primaryKey } from './common'
import { transactions } from './transactions'
import { users } from './users'

/**
 * 交易评价（#195 的数据模型，#287 批量落迁移）。
 *
 * 一笔交易的**买卖双方各一条**，所以唯一键是 `(transaction_id, author_id)` 而不是
 * 单列 `transaction_id` —— 后者会把对方那条评价直接堵死（#195 明确要求约束随业务规则走）。
 * `(author_id, created_at, id)` 供"我发过的评论"按作者聚合的稳定游标。
 *
 * `rating` 只做 notNull，**刻意不加 1..5 的范围 CHECK**：#195 的评分范围/内容约束
 * 尚未冻结，先落一条会被后续修订的 CHECK 不如让服务层先定，冻结后再补迁移。
 * `body` 可空：只打分不写评语是正常形态，用空串冒充"没写"反而要额外归一化。
 *
 * 两个外键都不带删除动作（NO ACTION），与 `transactions` 的既有口径一致：
 * 交易与评价是成交证据，不随账号删除连坐消失；真要清理得走显式的数据治理决定。
 */
export const transactionReviews = pgTable(
  'transaction_reviews',
  {
    ...primaryKey(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => transactions.id),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    rating: integer('rating').notNull(),
    body: text('body'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('transaction_reviews_transaction_id_author_id_uq').on(
      table.transactionId,
      table.authorId,
    ),
    index('transaction_reviews_author_id_created_at_id_idx').on(
      table.authorId,
      table.createdAt,
      table.id,
    ),
  ],
)
