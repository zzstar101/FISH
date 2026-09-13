import type { Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { sql } from 'drizzle-orm'

export interface MessageRow {
  id: string
  conversation_id: string
  sender_id: string | null
  type: string
  content: string
  created_at: Date | string
  /** join 出的发送者公开信息；SYSTEM 消息为 null。仅 listByConversation 填充。 */
  sender_nickname?: string | null
  sender_avatar_url?: string | null
}

/** 会话参与者的最小投影（权限判定用）。 */
export interface ConversationParticipant {
  id: string
  buyerId: string
  sellerId: string
}

export interface MessageStore {
  findConversationForUser(
    conversationId: string,
    userId: string,
  ): Promise<ConversationParticipant | null>
  /**
   * 取一页消息：ASC 返回；`before` 游标先在本会话内解析出 created_at（找不到返回
   * 'invalid-cursor'，由 service 报 422，防止伪造 uuid 变成 500）。
   */
  listByConversation(
    conversationId: string,
    filter: { limit: number; before: string | null },
  ): Promise<{ kind: 'ok'; rows: MessageRow[] } | { kind: 'invalid-cursor' }>
  /** 插入 TEXT 消息并 bump 会话的 last_message_at（同一事务，两写必须原子）。 */
  insertText(conversationId: string, senderId: string, content: string): Promise<MessageRow>
  /**
   * 服务端写入 SYSTEM 消息（#11 的交易提案/接受/拒绝）：无发送者，事务内 bump
   * last_message_at。不对客户端暴露——只有同属服务端的 domain 模块调用。
   */
  insertSystem(conversationId: string, content: string): Promise<MessageRow>
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}

function toRow(row: Record<string, unknown>): MessageRow {
  return {
    id: row.id as string,
    conversation_id: row.conversation_id as string,
    sender_id: (row.sender_id as string | null) ?? null,
    type: row.type as string,
    content: row.content as string,
    created_at: row.created_at as Date | string,
    sender_nickname: (row.sender_nickname as string | null) ?? null,
    sender_avatar_url: (row.sender_avatar_url as string | null) ?? null,
  }
}

export function createSqlMessageStore(db: Db): MessageStore {
  return {
    async findConversationForUser(conversationId, userId) {
      const result = await db.execute(sql`
        SELECT id, buyer_id, seller_id FROM conversations
        WHERE id = ${conversationId} AND ${userId} IN (buyer_id, seller_id)
      `)
      const row = rowsOf(result)[0]
      return row
        ? {
            id: row.id as string,
            buyerId: row.buyer_id as string,
            sellerId: row.seller_id as string,
          }
        : null
    },

    async listByConversation(conversationId, { limit, before }) {
      let cursorCreatedAt: string | undefined
      if (before) {
        // 游标消息必须属于本会话：跨会话的合法 uuid 也不能当作分页起点。
        const cursorResult = await db.execute(sql`
          SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts
          FROM messages WHERE id = ${before}::uuid AND conversation_id = ${conversationId}::uuid
        `)
        const cursorRow = rowsOf(cursorResult)[0]
        if (!cursorRow) return { kind: 'invalid-cursor' }
        cursorCreatedAt = cursorRow.ts as string
      }

      // 先按 DESC 取 limit+1 判断"还有没有更早的"，再反转成 ASC 返回
      // （契约：升序给前端、nextCursor 指向更早一页）。
      const condition = before
        ? sql`AND (m.created_at, m.id) < (${cursorCreatedAt}::timestamptz, ${before}::uuid)`
        : sql``
      const result = await db.execute(sql`
        SELECT m.id, m.conversation_id, m.sender_id, m.type::text, m.content, m.created_at,
               u.nickname AS sender_nickname, u.avatar_url AS sender_avatar_url
        FROM messages m
        LEFT JOIN users u ON u.id = m.sender_id
        WHERE m.conversation_id = ${conversationId}::uuid ${condition}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ${limit + 1}
      `)
      return { kind: 'ok', rows: rowsOf(result).map(toRow).reverse() }
    },

    /**
     * 插入 TEXT 消息并 bump 会话的 `last_message_at`（同一事务，两写必须原子）。
     *
     * `GREATEST(...)` 不是多余的防御：`created_at` 取 `defaultNow()` = **事务开始时间**，
     * 因此「早开始、晚拿到会话行锁」的事务会用更旧的时间戳覆盖新值，让会话在列表里
     * 位置倒退、游标分页出错。READ COMMITTED 下被阻塞的 UPDATE 会基于最新已提交版本
     * 重算表达式，所以 GREATEST 足以保证 `last_message_at` 只前进、不回退。
     */
    async insertText(conversationId, senderId, content) {
      return db.transaction(async (tx) => {
        const result = await tx.execute(sql`
          WITH msg AS (
            INSERT INTO messages (id, conversation_id, sender_id, type, content)
            VALUES (${newId()}, ${conversationId}::uuid, ${senderId}::uuid, 'TEXT', ${content})
            RETURNING id, conversation_id, sender_id, type::text, content, created_at
          ), bump AS (
            UPDATE conversations c SET
              last_message_at = GREATEST(c.last_message_at, (SELECT created_at FROM msg)),
              updated_at = now()
            FROM msg WHERE c.id = msg.conversation_id
          )
          SELECT msg.*, u.nickname AS sender_nickname, u.avatar_url AS sender_avatar_url
          FROM msg LEFT JOIN users u ON u.id = msg.sender_id
        `)
        const row = rowsOf(result)[0]
        if (!row) throw new Error('消息插入失败：会话可能已被并发删除')
        return toRow(row)
      })
    },

    async insertSystem(conversationId, content) {
      // 与 insertText 同构，仅 sender 为 NULL（DB CHECK 只约束 TEXT 必须有发送者）。
      return db.transaction((tx) => insertSystemWithin(tx, conversationId, content))
    },
  }
}

/**
 * 在**调用方给定的事务内**插入 SYSTEM 消息并 bump 会话的 `last_message_at`。
 *
 * 抽出来是为了让 #11 的 `accept` 能把「创建交易」与「写 `tx.accepted` 消息」放进同一个
 * 数据库事务（#40-3）：分两次提交时，消息写失败会留下「交易已创建、确认消息永久缺失」的
 * 部分成功，而重试只会拿到 409，客户端还会把「其实已经成功」当成失败。
 *
 * 事务句柄类型从 `Db` 推导（与 `packages/db/src/seed.ts` 的 `SeedTx` 同法），不硬编码
 * 驱动的内部类型。
 */
export type MessageTx = Parameters<Parameters<Db['transaction']>[0]>[0]

export async function insertSystemWithin(
  tx: MessageTx,
  conversationId: string,
  content: string,
): Promise<MessageRow> {
  const result = await tx.execute(sql`
    WITH msg AS (
      INSERT INTO messages (id, conversation_id, sender_id, type, content)
      VALUES (${newId()}, ${conversationId}::uuid, NULL, 'SYSTEM', ${content})
      RETURNING id, conversation_id, sender_id, type::text, content, created_at
    ), bump AS (
      UPDATE conversations c SET
        last_message_at = GREATEST(c.last_message_at, (SELECT created_at FROM msg)),
        updated_at = now()
      FROM msg WHERE c.id = msg.conversation_id
    )
    SELECT msg.* FROM msg
  `)
  const row = rowsOf(result)[0]
  if (!row) throw new Error('SYSTEM 消息插入失败：会话可能已被并发删除')
  return toRow(row)
}
