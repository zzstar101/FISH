import { index, pgTable, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { createdAt, primaryKey } from './common'
import { listings } from './listings'
import { users } from './users'

/**
 * 收藏关系（#190 的数据模型，#287 批量落迁移）。
 *
 * 只承载"谁收藏了哪件商品"这一条关系，不含计数列与失效快照：
 * - `unique(user_id, listing_id)` 让重复收藏走幂等（ON CONFLICT DO NOTHING），
 *   而不是在服务层读一次再写（并发下会插进两行）；
 * - `(user_id, created_at, id)` 是"我的收藏"列表的稳定游标顺序：`created_at` 可能同值，
 *   末列 `id` 保证翻页不重不漏。
 *
 * 外键的删除行为是**刻意不对称**的：
 * - 用户被删除 → 关系跟着消失（CASCADE），收藏是账号的从属数据；
 * - 商品被删除 → NO ACTION（不预设 CASCADE）。#190 明确"商品彻底删除后的收藏如何处理
 *   仍待 Owner 决定"，此时用 CASCADE 等于替 Owner 做出"静默丢弃收藏"的决定，
 *   用 NO ACTION 则会让物理删除先撞上外键报错，把决定留在明面上。
 *   （商品下架走 `listings.status = 'OFFLINE'`，不触发这条外键。）
 */
export const favorites = pgTable(
  'favorites',
  {
    ...primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => listings.id),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('favorites_user_id_listing_id_uq').on(table.userId, table.listingId),
    index('favorites_user_id_created_at_id_idx').on(table.userId, table.createdAt, table.id),
  ],
)
