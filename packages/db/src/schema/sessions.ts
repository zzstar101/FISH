import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { createdAt, primaryKey } from './common'
import { users } from './users'

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

/**
 * 登录会话（#3）。
 *
 * 明文令牌只存在于 httpOnly cookie 里，库里存 SHA-256：库被读走也无法直接冒用。
 * 相比无状态签名令牌，它的价值是**能真正吊销**——`POST /auth/logout` 删行即失效。
 * 每次登录插一行，因此多设备 / 多标签天然各自独立。
 */
export const sessions = pgTable(
  'sessions',
  {
    ...primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    /** 固定 30 天，不滑动续期（#3 决策）。过期行由读取路径惰性删除。 */
    expiresAt: timestamptz('expires_at').notNull(),
    // 不可变行：只取 createdAt，不取 updatedAt。
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_uq').on(table.tokenHash),
    // 删除用户时的级联需要按 user_id 定位；惰性清理按 expires_at 扫。
    index('sessions_user_id_idx').on(table.userId),
    index('sessions_expires_at_idx').on(table.expiresAt),
  ],
)
