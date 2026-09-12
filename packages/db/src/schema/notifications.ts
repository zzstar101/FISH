import { sql } from 'drizzle-orm'
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from './common'
import { users } from './users'

/** 通知类型值集尚未冻结（P1 还会加降价通知），故用 text + TS 收窄，不用 pgEnum。 */
export type NotificationType = 'MATCH'

/** 跳转所需的实体 ID，文案由客户端按 type 渲染。 */
export type NotificationPayload = {
  listingId?: string
  wishId?: string
  matchId?: string
}

export const notifications = pgTable(
  'notifications',
  {
    ...primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').$type<NotificationType>().notNull(),
    payload: jsonb('payload').$type<NotificationPayload>().notNull().default({}),
    /** NULL 即未读。 */
    readAt: timestamp('read_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
  },
  (table) => [
    index('notifications_user_id_created_at_idx').on(table.userId, table.createdAt),
    // 未读角标是热查询
    index('notifications_user_id_unread_idx').on(table.userId).where(sql`${table.readAt} IS NULL`),
  ],
)
