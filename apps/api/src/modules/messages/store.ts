import type { Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { sql } from 'drizzle-orm'
import {
  MessageIdempotencyConflictError,
  type MessageSendKey,
  sendKeyLockQuery,
} from './idempotency'

export interface MessageRow {
  id: string
  conversation_id: string
  sender_id: string | null
  type: string
  content: string
  /** #359 3c 引用的被引用消息 id；无引用为 null。 */
  reply_to_id?: string | null
  /** #359 3c 撤回时间；未撤回为 null。 */
  recalled_at?: Date | string | null
  created_at: Date | string
  /** join 出的发送者公开信息；SYSTEM 消息为 null。仅 listByConversation 填充。 */
  sender_nickname?: string | null
  sender_avatar_url?: string | null
}

/** 引用块投射需要的被引用行（#359 3c）。 */
export interface ReplyTargetRow {
  id: string
  /** 引用目标必须与本会话一致（跨会话 id 不可引用，也不泄漏存在性）。 */
  conversation_id: string
  sender_id: string | null
  type: string
  content: string
  recalled_at: Date | string | null
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
  /**
   * 插入 TEXT 消息并 bump 会话的 `last_message_at`（同一事务，两写必须原子）。
   *
   * 带 `key` 时启用 #67 发送幂等：同键同指纹 → 返回**既有**消息（不新增行）；同键不同
   * 指纹 → 抛 `MessageIdempotencyConflictError`。查重与插入在同一事务里，串行化见
   * `sendKeyLockQuery`。
   */
  insertText(
    conversationId: string,
    senderId: string,
    content: string,
    key?: MessageSendKey | null,
    replyToId?: string | null,
  ): Promise<MessageRow>
  /**
   * 按内部 uuid 批量取引用块投射需要的行（#359 3c）。缺失的 id 不在返回 Map 里
   * （行被并发删除），调用方按「引用已失效」渲染。
   */
  findReplyTargets(ids: string[]): Promise<Map<string, ReplyTargetRow>>
  /**
   * 幂等键查询（**只读、不在事务内**）：命中时返回既有行与指纹是否一致。
   *
   * service 在**引用目标校验之前**调它，让「第一次已落库、响应丢了」的重试直接重放既有行
   * —— 否则那条重试会因为「被引用消息此刻已撤回」撞 422，而消息其实早就发出去了
   * （媒体域 `media-store.ts` 的 `findByRequestKey` 是同一套快速路径）。
   *
   * 这只是**快速路径**，不是去重的权威判据：真正的串行化仍由 `insertText` 事务内的
   * advisory lock + 查重承担（本查询命中不了未提交的并发行）。
   */
  findByRequestKey(
    conversationId: string,
    senderId: string,
    key: MessageSendKey,
  ): Promise<{ row: MessageRow; matchedHash: boolean } | null>
  /**
   * 撤回（#359 3c）：把 `recalled_at` 从 NULL 单调推进为 now，返回撤回后的行。
   *
   * 返回 `'not-found'`：消息不在本会话；`'forbidden'`：不是发送者（含 SYSTEM，
   * 它的 sender_id 为 NULL）；`'window-exceeded'`：超出窗口。已撤回的行**幂等返回**，
   * 不刷新时间戳（重复点撤回不该把「撤回时刻」往后挪）。
   */
  recall(
    conversationId: string,
    messageId: string,
    userId: string,
    windowMs: number,
  ): Promise<MessageRow | 'not-found' | 'forbidden' | 'window-exceeded'>
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
    reply_to_id: (row.reply_to_id as string | null) ?? null,
    recalled_at: (row.recalled_at as Date | string | null) ?? null,
    created_at: row.created_at as Date | string,
    sender_nickname: (row.sender_nickname as string | null) ?? null,
    sender_avatar_url: (row.sender_avatar_url as string | null) ?? null,
  }
}

/**
 * 幂等键命中查询（只应在持有该键 advisory lock 的事务内调用）。
 *
 * `hashMatches=false` 表示「同键不同内容」，由调用方报 409；`null` 表示键未被使用。
 * 指纹在 SQL 里比较而不是取回 JS，省一次往返也少一个时序窗口。
 */
async function findByRequestKey(
  tx: MessageTx,
  conversationId: string,
  senderId: string,
  key: MessageSendKey,
): Promise<{ row: Record<string, unknown>; hashMatches: boolean } | null> {
  const result = await tx.execute(sql`
    SELECT m.id, m.conversation_id, m.sender_id, m.type::text, m.content, m.created_at,
           m.reply_to_id, m.recalled_at,
           u.nickname AS sender_nickname, u.avatar_url AS sender_avatar_url,
           (m.client_request_hash = ${key.requestHash}) AS hash_matches
    FROM messages m
    LEFT JOIN users u ON u.id = m.sender_id
    WHERE m.conversation_id = ${conversationId}::uuid
      AND m.sender_id = ${senderId}::uuid
      AND m.client_request_id = ${key.clientRequestId}
  `)
  const row = rowsOf(result)[0]
  return row ? { row, hashMatches: row.hash_matches === true } : null
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
        // 与主查询一致，MEDIA 消息不能作为文本分页锚点（fix-plan F8）。
        const cursorResult = await db.execute(sql`
          SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts
          FROM messages WHERE id = ${before}::uuid AND conversation_id = ${conversationId}::uuid
            AND type <> 'MEDIA'
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
               m.reply_to_id, m.recalled_at,
               u.nickname AS sender_nickname, u.avatar_url AS sender_avatar_url
        FROM messages m
        LEFT JOIN users u ON u.id = m.sender_id
        WHERE m.conversation_id = ${conversationId}::uuid
          AND m.type <> 'MEDIA'
          ${condition}
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
     *
     * 幂等键路径：先拿该键的 advisory lock 再查重，两个并发同键请求因此串行 —— 第二个
     * 读到第一个已提交的行并直接返回，不会撞唯一索引变成 500。
     */
    async insertText(conversationId, senderId, content, key, replyToId) {
      return db.transaction(async (tx) => {
        if (key) {
          await tx.execute(sendKeyLockQuery(conversationId, senderId, key.clientRequestId))
          const existing = await findByRequestKey(tx, conversationId, senderId, key)
          if (existing) {
            if (existing.hashMatches) return toRow(existing.row)
            throw new MessageIdempotencyConflictError(key.clientRequestId)
          }
        }
        const result = await tx.execute(sql`
          WITH msg AS (
            INSERT INTO messages
              (id, conversation_id, sender_id, type, content, client_request_id,
               client_request_hash, reply_to_id)
            VALUES (
              ${newId()}, ${conversationId}::uuid, ${senderId}::uuid, 'TEXT', ${content},
              ${key?.clientRequestId ?? null}, ${key?.requestHash ?? null},
              ${replyToId ?? null}::uuid
            )
            RETURNING id, conversation_id, sender_id, type::text, content, created_at,
                      reply_to_id, recalled_at
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

    async findByRequestKey(conversationId, senderId, key) {
      const result = await db.execute(sql`
        SELECT m.id, m.conversation_id, m.sender_id, m.type::text, m.content, m.created_at,
               m.reply_to_id, m.recalled_at,
               u.nickname AS sender_nickname, u.avatar_url AS sender_avatar_url,
               (m.client_request_hash = ${key.requestHash}) AS hash_matches
        FROM messages m
        LEFT JOIN users u ON u.id = m.sender_id
        WHERE m.conversation_id = ${conversationId}::uuid
          AND m.sender_id = ${senderId}::uuid
          AND m.client_request_id = ${key.clientRequestId}
      `)
      const row = rowsOf(result)[0]
      return row ? { row: toRow(row), matchedHash: row.hash_matches === true } : null
    },

    async findReplyTargets(ids) {
      const map = new Map<string, ReplyTargetRow>()
      if (ids.length === 0) return map
      const result = await db.execute(sql`
        SELECT id, conversation_id, sender_id, type::text, content, recalled_at
        FROM messages
        WHERE id IN (${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
      `)
      for (const row of rowsOf(result)) {
        map.set(row.id as string, {
          id: row.id as string,
          conversation_id: row.conversation_id as string,
          sender_id: (row.sender_id as string | null) ?? null,
          type: row.type as string,
          content: row.content as string,
          recalled_at: (row.recalled_at as Date | string | null) ?? null,
        })
      }
      return map
    },

    async recall(conversationId, messageId, userId, windowMs) {
      /*
       * 单语句完成「校验 + 推进」，避免「读出来再写回去」的竞态：
       * - 目标行必须在本会话（`conversation_id`）——跨会话的合法 id 一律 not-found，
       *   不泄漏其它会话的消息是否存在；
       * - 只有发送者本人可撤回（`sender_id = userId`；SYSTEM 的 sender_id 为 NULL，
       *   条件天然不成立，落进 forbidden）；
       * - 窗口按**数据库时钟**判（`clock_timestamp() - created_at`），不信客户端时间；
       * - `recalled_at = COALESCE(recalled_at, now())`：已撤回的行幂等命中原值，
       *   重复点撤回不会把「撤回时刻」往后挪。
       * 找不到行时 `RETURNING` 为空，再用一条只读查询区分 not-found / forbidden /
       * window-exceeded，把错误码说清楚。
       */
      const updated = await db.execute(sql`
        UPDATE messages SET recalled_at = COALESCE(recalled_at, now())
        WHERE id = ${messageId}::uuid
          AND conversation_id = ${conversationId}::uuid
          AND sender_id = ${userId}::uuid
          AND (
            recalled_at IS NOT NULL
            OR clock_timestamp() - created_at <= make_interval(secs => ${windowMs / 1000})
          )
        RETURNING id, conversation_id, sender_id, type::text, content, created_at,
                  reply_to_id, recalled_at
      `)
      const row = rowsOf(updated)[0]
      if (row) return toRow(row)

      const probe = await db.execute(sql`
        SELECT sender_id, recalled_at,
               (clock_timestamp() - created_at) > make_interval(secs => ${windowMs / 1000})
                 AS outside_window
        FROM messages
        WHERE id = ${messageId}::uuid AND conversation_id = ${conversationId}::uuid
      `)
      const target = rowsOf(probe)[0]
      if (!target) return 'not-found'
      if (target.sender_id !== userId) return 'forbidden'
      if (target.outside_window === true) return 'window-exceeded'
      return 'not-found'
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
 *
 * `created_at` 显式用 `clock_timestamp()`，而不是列默认的 `now()`（= `transaction_timestamp()`，
 * 在 BEGIN 时刻就固定）：本函数跑在**调用方的事务**里，而该事务在插入之前可能长时间等锁
 * （accept 要先拿 listing 行锁）。用 `now()` 会让这条消息拿到「事务开始时刻」这个更旧的时间戳，
 * 于是先提交的 TEXT 消息在按 `(created_at, id)` 升序重排后反而排到它后面 —— 实时推送顺序与
 * 刷新后的历史顺序自相矛盾，且未读口径（`m.created_at > last_read_at`）会永久漏掉它。
 * 独立事务里的 `insertText` 不需要这样改：它是事务的第一条语句，`now()` 即插入时刻。
 */
export type MessageTx = Parameters<Parameters<Db['transaction']>[0]>[0]

export async function insertSystemWithin(
  tx: MessageTx,
  conversationId: string,
  content: string,
): Promise<MessageRow> {
  const result = await tx.execute(sql`
    WITH msg AS (
      INSERT INTO messages (id, conversation_id, sender_id, type, content, created_at)
      VALUES (${newId()}, ${conversationId}::uuid, NULL, 'SYSTEM', ${content}, clock_timestamp())
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
