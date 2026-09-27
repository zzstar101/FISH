import { sql } from 'drizzle-orm'
import { check, index, pgTable, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { createdAt, primaryKey } from './common'
import { users } from './users'

/**
 * 关注关系（#188 的数据模型，#287 批量落迁移）。
 *
 * 有向关系：`follower_id` 关注 `following_id`。三条不变量都在 DB 层兜底：
 * - `unique(follower_id, following_id)`：重复关注靠 ON CONFLICT DO NOTHING 幂等，不靠先读后写；
 * - `check(follower_id <> following_id)`：自关注在写入侧就不可表达（服务层不该是唯一防线）；
 * - 两个方向的 `(…, created_at, id)` 游标索引：`(follower_id, …)` 服务"我的关注"，
 *   `(following_id, …)` 服务粉丝方向与互关判定——同一个唯一索引只能覆盖前一列前缀，
 *   反向列表仍要全表扫。
 *
 * 用户删除时两侧关系一并清理（CASCADE）：关系行离开用户没有任何意义，
 * 留着还会让"关注了已注销账号"变成幽灵行。
 */
export const follows = pgTable(
  'follows',
  {
    ...primaryKey(),
    followerId: uuid('follower_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    followingId: uuid('following_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('follows_follower_id_following_id_uq').on(table.followerId, table.followingId),
    check('follows_no_self_follow', sql`${table.followerId} <> ${table.followingId}`),
    index('follows_follower_id_created_at_id_idx').on(table.followerId, table.createdAt, table.id),
    index('follows_following_id_created_at_id_idx').on(
      table.followingId,
      table.createdAt,
      table.id,
    ),
  ],
)
