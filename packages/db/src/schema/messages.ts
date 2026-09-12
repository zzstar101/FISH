import { index, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { createdAt, primaryKey } from './common'
import { conversations } from './conversations'
import { users } from './users'

/** #9 的 P0 消息类型；不实现 OFFER。 */
export const messageTypeEnum = pgEnum('message_type', ['TEXT', 'SYSTEM'])

/** 不可变行：只有 created_at，没有 updated_at。 */
export const messages = pgTable(
  'messages',
  {
    ...primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** SYSTEM 消息没有发送者。 */
    senderId: uuid('sender_id').references(() => users.id),
    type: messageTypeEnum('type').notNull(),
    content: text('content').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    // 拉历史按 (created_at, id) 排序；未读数也走这个索引的前缀
    index('messages_conversation_id_created_at_id_idx').on(
      table.conversationId,
      table.createdAt,
      table.id,
    ),
  ],
)
