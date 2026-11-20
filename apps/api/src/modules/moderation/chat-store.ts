import type { Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { jsonParam } from '@fish/db/json'
import { adminAuditLogs } from '@fish/db/schema/admin'
import { sql } from 'drizzle-orm'
import { type AdminCursor, createdAtCursorText, cursorCondition } from '../admin/cursor'

/** 管理端待审项：审核记录 + 单条消息的最小上下文。 */
export type ChatModerationQueueRow = {
  id: string
  messageId: string
  conversationId: string
  senderId: string
  senderNickname: string
  kind: string
  decision: string
  suggestion: string | null
  provider: string
  policyVersion: string
  score: number | null
  matchedRules: string[]
  matchedTermsMasked: string[]
  version: number
  content: string | null
  mimeType: string | null
  sizeBytes: number | null
  createdAtCursor: string
  createdAt: Date
}

export type ChatModerationDecisionOutcome = 'applied' | 'replayed' | 'conflict' | 'not-found'

export type ChatModerationMessageRow = {
  id: string
  conversation_id: string
  sender_id: string
  type: string
  content: string
  reply_to_id: string | null
  recalled_at: Date | null
  created_at: Date
  sender_nickname: string | null
  sender_avatar_url: string | null
  visibility: string
  /** MEDIA 消息（ALLOW 后推 media.new 用）；TEXT/其它为 null。 */
  media?: {
    id: string
    kind: 'IMAGE' | 'VOICE'
    mimeType: string
    sizeBytes: number
    width: number | null
    height: number | null
    durationMs: number | null
  } | null
}

export type ChatModerationDecisionResult =
  | { outcome: 'not-found' }
  | { outcome: 'conflict' }
  | {
      outcome: 'applied' | 'replayed'
      recordId: string
      messageId: string
      conversationId: string
      buyerId: string
      sellerId: string
      visibility: 'DELIVERED' | 'REJECTED'
      message: ChatModerationMessageRow
    }

export type MediaSnapshot = {
  objectKey: string
  contentType: string
  sizeBytes: number | null
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}

const queueSelect = sql`
  r.id, r.message_id, r.conversation_id, r.sender_id, r.kind::text AS kind,
  r.decision::text AS decision, r.suggestion, r.provider, r.policy_version, r.score,
  r.matched_rules, r.matched_terms_masked, r.version, r.created_at,
  ${createdAtCursorText(sql`r.created_at`)} AS created_at_cursor,
  m.content, m.recalled_at, mm.mime_type, mm.size_bytes,
  u.nickname AS sender_nickname
  FROM chat_moderation_records r
  JOIN messages m ON m.id = r.message_id
  JOIN users u ON u.id = r.sender_id
  LEFT JOIN message_media mm ON mm.message_id = r.message_id
`

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[]
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return Array.isArray(parsed) ? (parsed as string[]) : []
    } catch {
      return []
    }
  }
  return []
}

function queueRowFrom(row: Record<string, unknown>): ChatModerationQueueRow {
  return {
    id: String(row.id),
    messageId: String(row.message_id),
    conversationId: String(row.conversation_id),
    senderId: String(row.sender_id),
    senderNickname: String(row.sender_nickname),
    kind: String(row.kind),
    decision: String(row.decision),
    suggestion: (row.suggestion as string | null) ?? null,
    provider: String(row.provider),
    policyVersion: String(row.policy_version),
    score: row.score === null || row.score === undefined ? null : Number(row.score),
    matchedRules: stringArray(row.matched_rules),
    matchedTermsMasked: stringArray(row.matched_terms_masked),
    version: Number(row.version),
    content: (row.content as string | null) ?? null,
    mimeType: (row.mime_type as string | null) ?? null,
    sizeBytes:
      row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
    createdAtCursor: String(row.created_at_cursor),
    createdAt: new Date(row.created_at as string | Date),
  }
}

function messageRowFrom(row: Record<string, unknown>): ChatModerationMessageRow {
  return {
    id: String(row.id),
    conversation_id: String(row.conversation_id),
    sender_id: String(row.sender_id),
    type: String(row.type),
    content: String(row.content),
    reply_to_id: (row.reply_to_id as string | null) ?? null,
    recalled_at: row.recalled_at ? new Date(row.recalled_at as string | Date) : null,
    created_at: new Date(row.created_at as string | Date),
    sender_nickname: (row.sender_nickname as string | null) ?? null,
    sender_avatar_url: (row.sender_avatar_url as string | null) ?? null,
    visibility: String(row.visibility),
    media:
      row.media_id === null || row.media_id === undefined
        ? null
        : {
            id: String(row.media_id),
            kind: String(row.media_kind) as 'IMAGE' | 'VOICE',
            mimeType: String(row.mime_type),
            sizeBytes: Number(row.size_bytes),
            width: row.width === null || row.width === undefined ? null : Number(row.width),
            height: row.height === null || row.height === undefined ? null : Number(row.height),
            durationMs:
              row.duration_ms === null || row.duration_ms === undefined
                ? null
                : Number(row.duration_ms),
          },
  }
}

export interface ChatModerationStore {
  listPending(criteria: {
    cursor: AdminCursor | null
    limit: number
  }): Promise<ChatModerationQueueRow[]>
  decide(input: {
    recordId: string
    decision: 'ALLOW' | 'BLOCK'
    reason: string
    version: number
    actorUserId: string
  }): Promise<ChatModerationDecisionResult>
  findMediaSnapshot(recordId: string): Promise<MediaSnapshot | null>
}

export function createSqlChatModerationStore(db: Db): ChatModerationStore {
  return {
    async listPending(criteria) {
      const where = criteria.cursor
        ? sql`WHERE r.status = 'PENDING' AND ${cursorCondition(sql`r.created_at`, sql`r.id`, criteria.cursor)}`
        : sql`WHERE r.status = 'PENDING'`
      const result = await db.execute(sql`
        SELECT ${queueSelect}
        ${where}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ${criteria.limit}
      `)
      return rowsOf(result).map(queueRowFrom)
    },

    async decide(input) {
      return db.transaction(async (tx) => {
        const locked = await tx.execute(sql`
          SELECT r.id, r.status::text AS status, r.decision::text AS decision,
                 r.machine_decision::text AS machine_decision, r.version,
                 r.message_id, r.conversation_id, c.buyer_id, c.seller_id,
                 m.visibility::text AS visibility
          FROM chat_moderation_records r
          JOIN conversations c ON c.id = r.conversation_id
          JOIN messages m ON m.id = r.message_id
          WHERE r.id = ${input.recordId}
          FOR UPDATE OF r, m
        `)
        const row = rowsOf(locked)[0]
        if (!row) return { outcome: 'not-found' as const }

        const status = String(row.status)
        const currentDecision = String(row.decision)
        const messageId = String(row.message_id)
        const conversationId = String(row.conversation_id)
        const buyerId = String(row.buyer_id)
        const sellerId = String(row.seller_id)

        if (status === 'SETTLED') {
          if (currentDecision === input.decision) {
            const message = await loadMessage(tx, messageId)
            if (!message) return { outcome: 'not-found' as const }
            return {
              outcome: 'replayed' as const,
              recordId: input.recordId,
              messageId,
              conversationId,
              buyerId,
              sellerId,
              visibility:
                input.decision === 'ALLOW' ? ('DELIVERED' as const) : ('REJECTED' as const),
              message,
            }
          }
          return { outcome: 'conflict' as const }
        }

        if (Number(row.version) !== input.version) return { outcome: 'conflict' as const }

        const visibility = input.decision === 'ALLOW' ? 'DELIVERED' : 'REJECTED'
        const updated = await tx.execute(sql`
          UPDATE chat_moderation_records
          SET decision = ${input.decision}::moderation_decision,
              status = 'SETTLED',
              reviewed_by = ${input.actorUserId},
              reviewed_at = now(),
              review_note = ${input.reason},
              version = version + 1,
              updated_at = now()
          WHERE id = ${input.recordId} AND status = 'PENDING' AND version = ${input.version}
          RETURNING id
        `)
        if (rowsOf(updated).length === 0) return { outcome: 'conflict' as const }

        await tx.execute(sql`
          UPDATE messages
          SET visibility = ${visibility}::message_visibility,
              delivered_at = CASE WHEN ${visibility} = 'DELIVERED'
                                  THEN COALESCE(delivered_at, now()) ELSE delivered_at END
          WHERE id = ${messageId}
        `)

        await tx.insert(adminAuditLogs).values({
          id: newId(),
          actorUserId: input.actorUserId,
          action: 'CHAT_MODERATION_DECISION',
          targetType: 'CHAT_MODERATION_RECORD',
          targetId: input.recordId,
          before: jsonParam({ status: 'PENDING', decision: currentDecision }),
          after: jsonParam({ status: 'SETTLED', decision: input.decision, messageId }),
          reason: input.reason,
        })

        const message = await loadMessage(tx, messageId)
        if (!message) return { outcome: 'not-found' as const }
        return {
          outcome: 'applied' as const,
          recordId: input.recordId,
          messageId,
          conversationId,
          buyerId,
          sellerId,
          visibility,
          message,
        }
      })
    },

    async findMediaSnapshot(recordId) {
      const result = await db.execute(sql`
        SELECT mm.object_key, mm.mime_type, mm.size_bytes
        FROM chat_moderation_records r
        JOIN message_media mm ON mm.message_id = r.message_id
        WHERE r.id = ${recordId}
        LIMIT 1
      `)
      const row = rowsOf(result)[0]
      if (!row) return null
      return {
        objectKey: String(row.object_key),
        contentType: String(row.mime_type),
        sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
      }
    },
  }
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

async function loadMessage(tx: Tx, messageId: string): Promise<ChatModerationMessageRow | null> {
  const result = await tx.execute(sql`
    SELECT m.id, m.conversation_id, m.sender_id, m.type::text AS type, m.content,
           m.reply_to_id, m.recalled_at, m.created_at, m.visibility::text AS visibility,
           u.nickname AS sender_nickname, u.avatar_url AS sender_avatar_url,
           mm.id AS media_id, mm.kind::text AS media_kind, mm.mime_type, mm.size_bytes,
           mm.width, mm.height, mm.duration_ms
    FROM messages m
    LEFT JOIN users u ON u.id = m.sender_id
    LEFT JOIN message_media mm ON mm.message_id = m.id
    WHERE m.id = ${messageId}
    LIMIT 1
  `)
  const row = rowsOf(result)[0]
  return row ? messageRowFrom(row) : null
}
