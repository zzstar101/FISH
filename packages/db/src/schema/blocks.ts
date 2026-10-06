import { sql } from 'drizzle-orm'
import { check, index, pgTable, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { createdAt, primaryKey } from './common'
import { users } from './users'

/**
 * 用户拉黑关系（#466 的数据模型）。
 *
 * 有向关系：`blocker_id` 拉黑了 `blocked_id`，但**生效是双向的**——守卫在 chat 域
 * service 层用「任一方向存在即拦截」实现（`existsBlockBetween`），所以表只存建立方向
 * 这一条边。三条不变量都在 DB 层兜底：
 * - `unique(blocker_id, blocked_id)`：重复拉黑靠 ON CONFLICT DO NOTHING 幂等，不靠先读后写；
 * - `check(blocker_id <> blocked_id)`：自拉黑在写入侧就不可表达（服务层显式 422，#466 验收「禁止拉黑自己」）；
 * - `(blocker_id, created_at, id)` 游标索引服务「我的黑名单」列表（只读建立方向，
 *   不提供「谁拉黑了我」的读取路径——那会让被拉黑变成可探测状态）。
 *
 * 用户删除时两侧关系一并清理（CASCADE）：拉黑行离开用户没有任何意义。
 * 解除拉黑 = 删除这一行（无条件 DELETE，幂等），双向守卫随之消失，历史消息保留。
 */
export const userBlocks = pgTable(
  'user_blocks',
  {
    ...primaryKey(),
    blockerId: uuid('blocker_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    blockedId: uuid('blocked_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('user_blocks_blocker_id_blocked_id_uq').on(table.blockerId, table.blockedId),
    check('user_blocks_no_self_block', sql`${table.blockerId} <> ${table.blockedId}`),
    index('user_blocks_blocker_id_created_at_id_idx').on(
      table.blockerId,
      table.createdAt,
      table.id,
    ),
  ],
)
