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
 *
 * 过期回收的取舍：只有「带着过期 cookie 再次访问」的行会被顺手删除；浏览器 cookie 到期后
 * 不再发送它，因此那行会残留。残留行不可用于登录（校验时按过期拒绝），代价是表会单调增长；
 * 定期清理属于 #13 的收尾范围，本期不做。
 */
export const sessions = pgTable(
  'sessions',
  {
    ...primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    /** 固定 30 天，不滑动续期（#3 决策）。 */
    expiresAt: timestamptz('expires_at').notNull(),
    // 不可变行：只取 createdAt，不取 updatedAt。
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_uq').on(table.tokenHash),
    // 删除用户时的级联需要按 user_id 定位。
    //
    // 刻意**不**建 expires_at 索引：过期行只在「该 cookie 再次被送来」时才删，没有
    // 按 expires_at 扫描的查询，长期不再访问的过期行会残留（见 service/session.ts 的说明）。
    // 将来加定期清理时再补索引。
    index('sessions_user_id_idx').on(table.userId),
  ],
)
