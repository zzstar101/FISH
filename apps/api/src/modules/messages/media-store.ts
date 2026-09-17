import type { MediaKind, MediaMessageInput } from '@fish/contracts/chat/schema'
import type { Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { sql } from 'drizzle-orm'

export type MediaRow = {
  message_id: string
  conversation_id: string
  sender_id: string
  media_id: string
  kind: MediaKind
  object_key: string
  mime_type: string
  size_bytes: number
  width: number | null
  height: number | null
  duration_ms: number | null
  created_at: Date | string
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}

function toRow(row: Record<string, unknown>): MediaRow {
  return {
    message_id: row.message_id as string,
    conversation_id: row.conversation_id as string,
    sender_id: row.sender_id as string,
    media_id: row.media_id as string,
    kind: row.kind as MediaKind,
    object_key: row.object_key as string,
    mime_type: row.mime_type as string,
    size_bytes: row.size_bytes as number,
    width: (row.width as number | null) ?? null,
    height: (row.height as number | null) ?? null,
    duration_ms: (row.duration_ms as number | null) ?? null,
    created_at: row.created_at as Date | string,
  }
}

export interface MediaMessageStore {
  participant(
    conversationId: string,
    userId: string,
  ): Promise<{ buyerId: string; sellerId: string } | null>
  create(conversationId: string, senderId: string, input: MediaMessageInput): Promise<MediaRow>
  list(conversationId: string, userId: string, limit: number): Promise<MediaRow[]>
  find(conversationId: string, mediaId: string, userId: string): Promise<MediaRow | null>
}

export function createSqlMediaMessageStore(db: Db): MediaMessageStore {
  return {
    async participant(conversationId, userId) {
      const result = await db.execute(sql`
        SELECT buyer_id, seller_id FROM conversations
        WHERE id = ${conversationId}::uuid
          AND ${userId}::uuid IN (buyer_id, seller_id)
      `)
      const row = rowsOf(result)[0]
      return row ? { buyerId: row.buyer_id as string, sellerId: row.seller_id as string } : null
    },

    async create(conversationId, senderId, input) {
      return db.transaction(async (tx) => {
        const messageId = newId()
        const mediaId = newId()
        const result = await tx.execute(sql`
          WITH msg AS (
            INSERT INTO messages (id, conversation_id, sender_id, type, content, created_at)
            VALUES (${messageId}::uuid, ${conversationId}::uuid, ${senderId}::uuid, 'MEDIA', '[media]', clock_timestamp())
            RETURNING id, conversation_id, sender_id, created_at
          ), media AS (
            INSERT INTO message_media
              (id, message_id, conversation_id, owner_id, kind, object_key, mime_type, size_bytes, width, height, duration_ms)
            VALUES (
              ${mediaId}::uuid, (SELECT id FROM msg), (SELECT conversation_id FROM msg),
              ${senderId}::uuid, ${input.kind}, ${input.objectKey}, ${input.contentType},
              ${input.sizeBytes}, ${'width' in input ? input.width : null},
              ${'height' in input ? input.height : null}, ${'durationMs' in input ? input.durationMs : null}
            )
            RETURNING *
          ), bump AS (
            UPDATE conversations c SET
              last_message_at = GREATEST(c.last_message_at, (SELECT created_at FROM msg)),
              updated_at = now()
            FROM msg WHERE c.id = msg.conversation_id
          )
          SELECT msg.id AS message_id, msg.conversation_id, msg.sender_id,
                 media.id AS media_id, media.kind::text, media.object_key, media.mime_type,
                 media.size_bytes, media.width, media.height, media.duration_ms, msg.created_at
          FROM msg CROSS JOIN media
        `)
        const row = rowsOf(result)[0]
        if (!row) throw new Error('媒体消息创建失败：会话可能已被删除')
        return toRow(row)
      })
    },

    async list(conversationId, userId, limit) {
      // 取会话内**最新** limit 条媒体（fix-plan F6）：长会话断线重连要能恢复最新媒体，
      // 旧实现按 ASC 取最早 limit 条，会在 >100 条后丢掉最新消息。DESC 取最新后反转回时间正序。
      const result = await db.execute(sql`
        SELECT m.id AS message_id, m.conversation_id, m.sender_id,
               mm.id AS media_id, mm.kind::text, mm.object_key, mm.mime_type,
               mm.size_bytes, mm.width, mm.height, mm.duration_ms, m.created_at
        FROM messages m
        JOIN message_media mm ON mm.message_id = m.id
        WHERE m.conversation_id = ${conversationId}::uuid
          AND ${userId}::uuid IN (
            SELECT buyer_id FROM conversations WHERE id = m.conversation_id
            UNION ALL SELECT seller_id FROM conversations WHERE id = m.conversation_id
          )
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ${limit}
      `)
      return rowsOf(result).map(toRow).reverse()
    },

    async find(conversationId, mediaId, userId) {
      const result = await db.execute(sql`
        SELECT m.id AS message_id, m.conversation_id, m.sender_id,
               mm.id AS media_id, mm.kind::text, mm.object_key, mm.mime_type,
               mm.size_bytes, mm.width, mm.height, mm.duration_ms, m.created_at
        FROM message_media mm
        JOIN messages m ON m.id = mm.message_id
        JOIN conversations c ON c.id = mm.conversation_id
        WHERE mm.id = ${mediaId}::uuid
          AND mm.conversation_id = ${conversationId}::uuid
          AND ${userId}::uuid IN (c.buyer_id, c.seller_id)
      `)
      const row = rowsOf(result)[0]
      return row ? toRow(row) : null
    },
  }
}
