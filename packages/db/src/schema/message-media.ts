import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { createdAt, primaryKey } from './common'
import { conversations } from './conversations'
import { messages } from './messages'
import { users } from './users'

export const messageMediaKindEnum = pgEnum('message_media_kind', ['IMAGE', 'VOICE'])

export const messageMedia = pgTable(
  'message_media',
  {
    ...primaryKey(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    kind: messageMediaKindEnum('kind').notNull(),
    objectKey: text('object_key').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('message_media_message_id_uq').on(table.messageId),
    uniqueIndex('message_media_object_key_uq').on(table.objectKey),
    index('message_media_conversation_id_created_at_idx').on(table.conversationId, table.createdAt),
    check('message_media_size_positive', sql`${table.sizeBytes} > 0`),
    check(
      'message_media_image_dimensions',
      sql`(${table.kind} <> 'IMAGE') OR (${table.width} IS NOT NULL AND ${table.height} IS NOT NULL)`,
    ),
    check(
      'message_media_voice_duration',
      sql`(${table.kind} <> 'VOICE') OR (${table.durationMs} IS NOT NULL AND ${table.durationMs} > 0)`,
    ),
  ],
)
