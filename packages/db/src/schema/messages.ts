import { sql } from 'drizzle-orm'
import { check, index, pgEnum, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { createdAt, primaryKey } from './common'
import { conversations } from './conversations'
import { users } from './users'

/** #9/#67 消息类型；旧 TEXT/SYSTEM 保持不变，媒体使用独立 MEDIA 行与 message_media 关联。 */
export const messageTypeEnum = pgEnum('message_type', ['TEXT', 'SYSTEM', 'MEDIA'])

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
    /**
     * #67 发送幂等键：客户端为「一次新发送」生成的 UUID，重试同一条消息时沿用。
     * 旧数据与 SYSTEM 消息为 NULL（不参与幂等）。
     */
    clientRequestId: text('client_request_id'),
    /**
     * #67 与 `clientRequestId` 配对的请求内容指纹（sha256 hex）。
     * 同键同指纹 = 重试，返回既有消息；同键不同指纹 = 幂等键复用，409 拒绝。
     */
    clientRequestHash: text('client_request_hash'),
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
    // #67 幂等唯一约束：`(sender, conversation, requestId)` 唯一。
    // 部分索引（只覆盖带键的新消息），旧数据与 SYSTEM 消息的 NULL 不参与唯一性。
    // 插入端在事务内先取 advisory lock 再查重（modules/messages/store.ts），本索引是
    // 并发竞态下的最后防线，而不是正常的去重路径。
    uniqueIndex('messages_sender_conversation_client_request_uq')
      .on(table.senderId, table.conversationId, table.clientRequestId)
      .where(sql`${table.clientRequestId} IS NOT NULL`),
  ],
)
