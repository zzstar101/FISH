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
 * - 商品被删除 → NO ACTION（不预设 CASCADE）。这条外键把「商品彻底删除后收藏怎么办」
 *   留在明面上而不是悄悄替人决定；**Owner 2026-09-28 拍板**了那个决定：不过审的商品被
 *   物理删除时，它的收藏一并清除（`listings/store.ts` 的 `deleteListingAtomic` 在删商品行
 *   之前显式 `DELETE FROM favorites`）。保持 NO ACTION 不动 —— 谁来删都绕不过这一层，
 *   少一个"外键顺手帮我删了"的隐式行为。
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
