import { sql } from 'drizzle-orm'
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from './common'
import { users } from './users'

/** 通知类型值集尚未冻结（P1 还会加降价通知），故用 text + TS 收窄，不用 pgEnum。
 *  与 `@fish/contracts/notifications/schema` 的 `notificationTypeSchema` 同步扩。 */
export type NotificationType = 'MATCH' | 'TX' | 'MODERATION' | 'ACCOUNT'

/** 跳转所需的实体 ID，文案由客户端按 type 渲染。库里存裸 UUID，读侧转公开 TypeID。 */
export type NotificationPayload = {
  listingId?: string
  wishId?: string
  matchId?: string
  /** TX：交易进展（PROPOSED 阶段提案不落表，无 transactionId，只有 conversationId） */
  transactionId?: string
  conversationId?: string
  event?: 'PROPOSED' | 'ACCEPTED' | 'REJECTED' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED'
  /** MODERATION / ACCOUNT：结论 */
  outcome?: 'APPROVED' | 'REJECTED'
  /** ACCOUNT：主题（P1 只有校园邮箱认证） */
  subject?: 'VERIFICATION'
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
