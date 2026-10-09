import { index, pgEnum, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps, timestamptz } from './common'
import { users } from './users'

/**
 * 反馈类型（#463）。与小程序反馈页 `pkg-legal/pages/feedback/draft.ts` 的 `FEEDBACK_TYPE_KEYS`
 * 一一对应（大写化）。清单本身的定稿归 #399；改清单时同步这里、契约与小程序常量。
 */
export const feedbackTypeEnum = pgEnum('feedback_type', [
  'BUG',
  'UX',
  'DISPUTE',
  'REPORT',
  'ACCOUNT',
  'OTHER',
])

/**
 * 反馈状态机：PENDING → REPLIED（已回复用户）/ CLOSED（不回复直接结单）。
 * 两个终态都由管理员一次写入，终态后不再变更。
 */
export const feedbackStatusEnum = pgEnum('feedback_status', ['PENDING', 'REPLIED', 'CLOSED'])

/**
 * 用户意见反馈（#463）。
 *
 * - `contact` 是用户自愿留的联系方式：只对本人与管理员可见，不进任何公开投影与日志。
 * - `(user_id, client_request_id)` 唯一：重复点击 / 网络超时重试命中同一行，不重复建单。
 * - `reply` 是**对用户可见**的回复；`handlingNote` 只给管理员看（与举报 `handling_reason` 同口径）。
 * - `userId` 用默认 `NO ACTION`：与 `reports.reporter_id` 同口径，提交人不可被静默抹掉。
 */
export const feedback = pgTable(
  'feedback',
  {
    ...primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    clientRequestId: uuid('client_request_id').notNull(),
    type: feedbackTypeEnum('type').notNull(),
    content: text('content').notNull(),
    contact: text('contact'),
    status: feedbackStatusEnum('status').notNull().default('PENDING'),
    reply: text('reply'),
    handlingNote: text('handling_note'),
    handledBy: uuid('handled_by').references(() => users.id),
    handledAt: timestamptz('handled_at'),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('feedback_user_client_request_uidx').on(table.userId, table.clientRequestId),
    // 管理端队列：按状态 + 时间倒序。
    index('feedback_status_created_at_idx').on(table.status, table.createdAt),
    // 「我的反馈」与频控计数：按提交人 + 时间倒序。
    index('feedback_user_created_at_idx').on(table.userId, table.createdAt),
  ],
)
