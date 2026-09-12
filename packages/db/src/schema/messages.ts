import { sql } from 'drizzle-orm'
import { check, index, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core'
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
    /** SYSTEM 消息可以没有发送者；TEXT 消息必须有（由下面的 CHECK 保证）。 */
    senderId: uuid('sender_id').references(() => users.id),
    type: messageTypeEnum('type').notNull(),
    content: text('content').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    // 用户发出的文本必须有身份；SYSTEM 侧不强制 sender_id IS NULL，
    // 因为 #9/#11 的 system message 契约是否要记录"触发者"尚未冻结。
    check(
      'messages_text_requires_sender',
      sql`${table.type} <> 'TEXT' OR ${table.senderId} IS NOT NULL`,
    ),
    // 拉历史按 (created_at, id) 排序；未读数也走这个索引的前缀
    index('messages_conversation_id_created_at_id_idx').on(
      table.conversationId,
      table.createdAt,
      table.id,
    ),
  ],
)
