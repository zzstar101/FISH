import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { createdAt, primaryKey } from './common'
import { transactions } from './transactions'
import { users } from './users'

/**
 * 评价档次（#195 冻结口径）：**好评 / 中评 / 差评**三档，不是连续的 1..5 星。
 *
 * 用枚举而不是 `integer + CHECK`：档次是封闭集合，枚举让非法值在写入侧就不可表达，
 * 也不会出现"3.5 星"这种区间约束管不住、只有服务层才知道合不合法的值。
 */
export const transactionReviewRatingEnum = pgEnum('transaction_review_rating', [
  'POSITIVE',
  'NEUTRAL',
  'NEGATIVE',
])

/**
 * 交易评价（#195 的数据模型，#287 落迁移）。
 *
 * #195 的六项待冻结口径已由 Owner 在 PR #310 审查中定案，本表按定案落地：
 *
 * 1. **可评价范围**：仅 `COMPLETED` 交易，参与者限该笔交易的 buyer / seller（一人一档）；
 * 2. **条数**：买卖双方**各一条** —— 所以唯一键是 `(transaction_id, author_id)` 而不是单列
 *    `transaction_id`：后者会把对方那条评价直接堵死，正是 #195 红线「不能先建单列唯一
 *    再声称支持双方评价」要避免的形态。跨行的"作者必须是本笔交易参与者""交易必须已完成"
 *    需要读另一行，CHECK 表达不了，由 #195 的写接口保证（这里只保证值域与不重复）；
 * 3. **评分**：三档枚举（好评 / 中评 / 差评），见上；不是 1..5 连续分值；
 * 4. **文字 `body`**：可空（只打分不写评语是正常形态，用空串冒充"没写"反而要额外归一化）；
 *    长度上限由契约收口，DB 是裸 `text`（与 `comments.content` / `listings.title` 同口径）；
 * 5. **图片**：可选 0..N 张，落 `transaction_review_images`（随评价行级联删除）；
 * 6. **不可修改**：不可变行，只有 `created_at`，没有 `updated_at`；本人可物理删除，
 *    「具体评价时间」由 `created_at` 承载。
 *
 * `(author_id, created_at, id)` 供"我发过的评论"按作者聚合的稳定游标（#195 读路径）。
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
    rating: transactionReviewRatingEnum('rating').notNull(),
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

/**
 * 评价配图（#195：评分 + 文字 + 图片，后两者可选不强制）。
 *
 * 与 `listing_images` 同款：只存 object key，URL 在读时用 `S3_PUBLIC_URL + '/' + object_key`
 * 拼。张数上限（跨行计数）由契约与写接口收口，DB 只保证同一评价内 `sort_order` 不重复、
 * 非负。图片属于评价：评价被本人物理删除时图片行级联删除（对象存储侧的清理由后续
 * 媒体治理流程承接，不在本次迁移范围）。
 */
export const transactionReviewImages = pgTable(
  'transaction_review_images',
  {
    ...primaryKey(),
    reviewId: uuid('review_id')
      .notNull()
      .references(() => transactionReviews.id, { onDelete: 'cascade' }),
    objectKey: text('object_key').notNull(),
    sortOrder: integer('sort_order').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('transaction_review_images_review_id_sort_order_uq').on(
      table.reviewId,
      table.sortOrder,
    ),
    check('transaction_review_images_sort_order_non_negative', sql`${table.sortOrder} >= 0`),
  ],
)
