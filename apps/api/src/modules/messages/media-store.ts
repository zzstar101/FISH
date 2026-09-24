import type { MediaKind, MediaMessageInput } from '@fish/contracts/chat/schema'
import type { Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { type SQL, sql } from 'drizzle-orm'
import {
  MessageIdempotencyConflictError,
  type MessageSendKey,
  sendKeyLockQuery,
} from './idempotency'

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
  /**
   * 微秒精度的 `created_at` 文本（DB 直接 `to_char`）。
   * JS Date 只有毫秒，用它做 `(created_at, id)` 游标会让同一毫秒边界上的行被跳过。
   */
  created_at_iso: string
}

/** 媒体列表游标：`(created_at, id)` 反向翻页（向更早）。 */
export type MediaListCursor = { createdAt: string; id: string }

/** #67 幂等键命中结果；`matchedHash=false` 表示同键不同内容（调用方报 409）。 */
export type MediaRequestLookup = { row: MediaRow; matchedHash: boolean }

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
    created_at_iso: row.created_at_iso as string,
  }
}

/**
 * 三处 SELECT 共用的列投影。
 * `created_at_iso` 用 `to_char(..., 'US')` 保住微秒，与 listings / conversations 的游标口径一致。
 */
const MEDIA_SELECT = sql`
  m.id AS message_id, m.conversation_id, m.sender_id,
  mm.id AS media_id, mm.kind::text, mm.object_key, mm.mime_type,
  mm.size_bytes, mm.width, mm.height, mm.duration_ms, m.created_at,
  to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_iso
`

/**
 * #67 幂等键命中查询（`db` 与事务 `tx` 共用）。
 *
 * 指纹在 SQL 里比较，省一次往返；`hash_matches` 供调用方区分「重试」与「同键换内容」。
 */
function mediaByRequestQuery(conversationId: string, senderId: string, key: MessageSendKey): SQL {
  return sql`
    SELECT ${MEDIA_SELECT}, (m.client_request_hash = ${key.requestHash}) AS hash_matches
    FROM messages m
    JOIN message_media mm ON mm.message_id = m.id
    WHERE m.conversation_id = ${conversationId}::uuid
      AND m.sender_id = ${senderId}::uuid
      AND m.client_request_id = ${key.clientRequestId}
  `
}

function toLookup(result: unknown): MediaRequestLookup | null {
  const row = rowsOf(result)[0]
  return row ? { row: toRow(row), matchedHash: row.hash_matches === true } : null
}

export interface MediaMessageStore {
  participant(
    conversationId: string,
    userId: string,
  ): Promise<{ buyerId: string; sellerId: string } | null>
  /**
   * 创建 MEDIA 消息 + message_media 行并 bump 会话（同一事务）。
   *
   * 带 `key` 时启用 #67 幂等：同键同指纹 → 返回既有媒体行（不新增）；同键不同指纹 →
   * 抛 `MessageIdempotencyConflictError`。
   */
  create(
    conversationId: string,
    senderId: string,
    input: MediaMessageInput,
    key?: MessageSendKey | null,
  ): Promise<MediaRow>
  list(
    conversationId: string,
    userId: string,
    filter: { limit: number; cursor: MediaListCursor | null },
  ): Promise<MediaRow[]>
  find(conversationId: string, mediaId: string, userId: string): Promise<MediaRow | null>
  /**
   * #67 幂等键查询：命中时返回既有媒体行。
   * service 在**上传校验与快照写入之前**调用它，让重试走快速路径而不是重写一份快照。
   */
  findByRequestKey(
    conversationId: string,
    senderId: string,
    key: MessageSendKey,
  ): Promise<MediaRequestLookup | null>
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

    async findByRequestKey(conversationId, senderId, key) {
      return toLookup(await db.execute(mediaByRequestQuery(conversationId, senderId, key)))
    },

    async create(conversationId, senderId, input, key) {
      return db.transaction(async (tx) => {
        if (key) {
          // 与文本路径同一套串行化：先拿键的 advisory lock，再查重；两个并发同键请求里
          // 第二个会阻塞到第一个提交，然后读到已提交行并直接返回。
          await tx.execute(sendKeyLockQuery(conversationId, senderId, key.clientRequestId))
          const existing = toLookup(
            await tx.execute(mediaByRequestQuery(conversationId, senderId, key)),
          )
          if (existing) {
            if (existing.matchedHash) return existing.row
            throw new MessageIdempotencyConflictError(key.clientRequestId)
          }
        }
        const messageId = newId()
        const mediaId = newId()
        const result = await tx.execute(sql`
          WITH msg AS (
            INSERT INTO messages
              (id, conversation_id, sender_id, type, content, created_at,
               client_request_id, client_request_hash)
            VALUES (
              ${messageId}::uuid, ${conversationId}::uuid, ${senderId}::uuid, 'MEDIA', '[media]',
              clock_timestamp(), ${key?.clientRequestId ?? null}, ${key?.requestHash ?? null}
            )
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
                 media.size_bytes, media.width, media.height, media.duration_ms, msg.created_at,
                 to_char(msg.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_iso
          FROM msg CROSS JOIN media
        `)
        const row = rowsOf(result)[0]
        if (!row) throw new Error('媒体消息创建失败：会话可能已被删除')
        return toRow(row)
      })
    },

    async list(conversationId, userId, { limit, cursor }) {
      // 取会话内**最新** limit+1 条（fix-plan F6 / 评审 major）：长会话断线重连要能恢复最新媒体。
      // 游标向更早翻页：`(created_at, id) < (cursor.createdAt, cursor.id)`。
      // 返回 DESC 顺序，由 service 反转成正序；多出的那条用于判断 `hasMore`。
      const condition = cursor
        ? sql`AND (m.created_at, m.id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
        : sql``
      const result = await db.execute(sql`
        SELECT ${MEDIA_SELECT}
        FROM messages m
        JOIN message_media mm ON mm.message_id = m.id
        WHERE m.conversation_id = ${conversationId}::uuid
          AND ${userId}::uuid IN (
            SELECT buyer_id FROM conversations WHERE id = m.conversation_id
            UNION ALL SELECT seller_id FROM conversations WHERE id = m.conversation_id
          )
          ${condition}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ${limit + 1}
      `)
      return rowsOf(result).map(toRow)
    },

    async find(conversationId, mediaId, userId) {
      const result = await db.execute(sql`
        SELECT ${MEDIA_SELECT}
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
