import type { Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { sql } from 'drizzle-orm'

/** conversations 表的行（snake_case 与 DB 列名一致）。 */
export interface ConversationRow {
  id: string
  listing_id: string
  buyer_id: string
  seller_id: string
  buyer_last_read_at: Date | string | null
  seller_last_read_at: Date | string | null
  last_message_at: Date | string
  created_at: Date | string
  updated_at: Date | string
}

/**
 * 会话 + 关联读模型的 joined 行。封面只给 objectKey，不拼 URL——
 * 存储布局是 uploads/#6 的实现细节，URL 由 service 经注入的 MediaStorage 生成。
 */
export interface ConversationDetailRow {
  conversation: ConversationRow
  listing: { id: string; title: string; priceCents: number; status: string; sellerId: string }
  counterpart: { id: string; nickname: string; avatarUrl: string | null }
  /** 查看者视角的未读数（对方或系统消息晚于我的 last_read_at）。 */
  unreadCount: number
  coverObjectKey: string | null
  /** 会话内最新一条消息（列表行摘要用）；尚无任何消息时为 null。 */
  lastMessage: {
    type: string
    content: string
    senderId: string | null
    createdAt: Date | string
  } | null
  /**
   * DB 侧生成的微秒精度 ISO 文本（游标排序键）。JS Date 只有毫秒，毫秒截断会让
   * 同毫秒边界行在翻页时消失（listings/cursor.ts 注释同源）；仅 listForUser 填充。
   */
  lastMessageAtCursor?: string
}

export interface ListingBrief {
  id: string
  sellerId: string
}

export type ChatWatcherRow = {
  conversationId: string
  startedAt: Date | string
  startedAtCursor: string
  userId: string
  nickname: string
  avatarUrl: string | null
  authStatus: 'UNVERIFIED' | 'VERIFIED'
}

export interface ConversationStore {
  findListingBrief(listingId: string): Promise<ListingBrief | null>
  /** 已建会话的买家；页与全量计数采用同一商品/卖家条件、同一数据库语句。 */
  listChatWatchers(
    listingId: string,
    sellerId: string,
    filter: { limit: number; cursor: { sortKey: string; id: string } | null },
  ): Promise<{ rows: ChatWatcherRow[]; total: number }>
  /** 幂等创建：同 (listing, buyer) 已存在时不插，返回 null（调用方改走 findDetail）。 */
  insertIfAbsent(
    listingId: string,
    buyerId: string,
    sellerId: string,
  ): Promise<ConversationRow | null>
  findIdByListingAndBuyer(listingId: string, buyerId: string): Promise<string | null>
  findDetail(conversationId: string, viewerId: string): Promise<ConversationDetailRow | null>
  /** 按 last_message_at 降序的一页；多取一行由调用方丢弃（契约不另给 hasMore）。 */
  listForUser(
    viewerId: string,
    filter: { limit: number; cursor: { sortKey: string; id: string } | null },
  ): Promise<ConversationDetailRow[]>
  /** 一页会话的封面 objectKey（每个 listing 取 sort_order = 0 的一张）。 */
  coverObjectKeys(listingIds: string[]): Promise<Map<string, string | null>>
  /**
   * 本人未读总数（#67）。聚合**全部**会话，不分页；判据与列表行 `unreadCount` 同源，
   * 因此恒等于「全部会话 unreadCount 之和」。
   */
  countUnread(viewerId: string): Promise<number>
  /** 把查看者一侧的 last_read_at 单调推进到 now（只前进不后退）；非参与者返回 null。 */
  markRead(conversationId: string, viewerId: string): Promise<ConversationDetailRow | null>
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}

function asDate(value: unknown): Date | string | null {
  return value == null ? null : (value as Date | string)
}

/** joined 行 → 读模型。字段名与下面的 SELECT 别名一一对应。 */
function toDetailRow(row: Record<string, unknown>): ConversationDetailRow {
  return {
    conversation: {
      id: row.id as string,
      listing_id: row.listing_id as string,
      buyer_id: row.buyer_id as string,
      seller_id: row.seller_id as string,
      buyer_last_read_at: asDate(row.buyer_last_read_at),
      seller_last_read_at: asDate(row.seller_last_read_at),
      last_message_at: row.last_message_at as Date | string,
      created_at: row.created_at as Date | string,
      updated_at: row.updated_at as Date | string,
    },
    listing: {
      id: row.listing_id as string,
      title: row.listing_title as string,
      priceCents: row.listing_price_cents as number,
      status: row.listing_status as string,
      sellerId: row.listing_seller_id as string,
    },
    counterpart: {
      id: row.counterpart_id as string,
      nickname: row.counterpart_nickname as string,
      avatarUrl: (row.counterpart_avatar_url as string | null) ?? null,
    },
    unreadCount: Number(row.unread_count),
    coverObjectKey: (row.cover_object_key as string | null) ?? null,
    lastMessage: row.last_message_created_at
      ? {
          type: row.last_message_type as string,
          content: row.last_message_content as string,
          senderId: (row.last_message_sender_id as string | null) ?? null,
          createdAt: asDate(row.last_message_created_at) as Date | string,
        }
      : null,
    lastMessageAtCursor: (row.last_message_at_cursor as string | undefined) ?? undefined,
  }
}

/**
 * 「查看者视角下这一行算未读」的 SQL 谓词；依赖外层查询的别名 `c` = conversations、`m` = messages。
 *
 * 会话列表行的 `unread_count` 子查询与 `countUnread` 的聚合**共用这一份**：分叉会让
 * 底栏红点与列表行在「对方还是 SYSTEM 发的」「未读边界」上各说各话。
 *
 * 未读 = 非 MEDIA、由对方或 SYSTEM（sender_id IS NULL）发出、且晚于我 last_read_at 的消息；
 * 我从未读过（last_read_at IS NULL）时全部计未读。会话严格双人，CASE 由 buyer/seller 二选一。
 */
const unreadMessagePredicate = (viewerId: string) => sql`
  m.type <> 'MEDIA'
  AND (m.sender_id IS NULL OR m.sender_id <> ${viewerId})
  AND (
    (CASE WHEN c.buyer_id = ${viewerId} THEN c.buyer_last_read_at ELSE c.seller_last_read_at END) IS NULL
    OR m.created_at > CASE WHEN c.buyer_id = ${viewerId} THEN c.buyer_last_read_at ELSE c.seller_last_read_at END
  )
`

/**
 * 会话的统一投影：join 商品（顶部商品卡）与对方用户，并按查看者角色计算未读数。
 * 未读判据见 `unreadMessagePredicate`（与 `countUnread` 同源）。
 */
const detailSelect = (viewerId: string) => sql`
  SELECT c.id, c.listing_id, c.buyer_id, c.seller_id,
         c.buyer_last_read_at, c.seller_last_read_at, c.last_message_at, c.created_at, c.updated_at,
         l.seller_id AS listing_seller_id, l.title AS listing_title,
         l.price_cents AS listing_price_cents, l.status::text AS listing_status,
         cu.id AS counterpart_id, cu.nickname AS counterpart_nickname,
         cu.avatar_url AS counterpart_avatar_url,
         to_char(c.last_message_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
           AS last_message_at_cursor,
         lm.type::text AS last_message_type, lm.content AS last_message_content,
         lm.sender_id AS last_message_sender_id, lm.created_at AS last_message_created_at,
         (SELECT count(*) FROM messages m
          WHERE m.conversation_id = c.id AND ${unreadMessagePredicate(viewerId)}
         ) AS unread_count
  FROM conversations c
  JOIN listings l ON l.id = c.listing_id
  JOIN users cu ON cu.id = (CASE WHEN c.buyer_id = ${viewerId} THEN c.seller_id ELSE c.buyer_id END)
  LEFT JOIN LATERAL (
    SELECT m.type, m.content, m.sender_id, m.created_at
    FROM messages m
    WHERE m.conversation_id = c.id AND m.type <> 'MEDIA'
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 1
  ) lm ON TRUE
`

export function createSqlConversationStore(db: Db): ConversationStore {
  return {
    async findListingBrief(listingId) {
      const result = await db.execute(
        sql`SELECT id, seller_id FROM listings WHERE id = ${listingId}`,
      )
      const row = rowsOf(result)[0]
      return row ? { id: row.id as string, sellerId: row.seller_id as string } : null
    },

    async listChatWatchers(listingId, sellerId, { limit, cursor }) {
      // created_at 不随聊天消息变化；同一 (listing_id,buyer_id) 仅一条会话。
      // LEFT JOIN LATERAL 让空页仍带回 total；计数与分页在同一 SQL 快照内、同一筛选条件。
      const condition = sql`c.listing_id = ${listingId}::uuid AND c.seller_id = ${sellerId}::uuid`
      const after = cursor
        ? sql`AND (c.created_at, c.id) < (${cursor.sortKey}::timestamptz, ${cursor.id}::uuid)`
        : sql``
      const result = await db.execute(sql`
        SELECT total.n, page.*
        FROM (SELECT count(*)::int AS n FROM conversations c WHERE ${condition}) total
        LEFT JOIN LATERAL (
          SELECT c.id, c.created_at,
                 to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor,
                 u.id AS user_id, u.nickname, u.avatar_url, u.auth_status::text AS auth_status
          FROM conversations c
          JOIN users u ON u.id = c.buyer_id
          WHERE ${condition} ${after}
          ORDER BY c.created_at DESC, c.id DESC
          LIMIT ${limit + 1}
        ) page ON TRUE
        ORDER BY page.created_at DESC, page.id DESC
      `)
      const rows = rowsOf(result)
      return {
        total: Number(rows[0]?.n ?? 0),
        rows: rows
          .filter((row) => row.id != null)
          .map((row) => ({
            conversationId: row.id as string,
            startedAt: row.created_at as Date | string,
            startedAtCursor: row.created_at_cursor as string,
            userId: row.user_id as string,
            nickname: row.nickname as string,
            avatarUrl: (row.avatar_url as string | null) ?? null,
            authStatus: row.auth_status as 'UNVERIFIED' | 'VERIFIED',
          })),
      }
    },

    async insertIfAbsent(listingId, buyerId, sellerId) {
      const result = await db.execute(sql`
        INSERT INTO conversations (id, listing_id, buyer_id, seller_id)
        VALUES (${newId()}, ${listingId}, ${buyerId}, ${sellerId})
        ON CONFLICT (listing_id, buyer_id) DO NOTHING
        RETURNING id, listing_id, buyer_id, seller_id,
                  buyer_last_read_at, seller_last_read_at, last_message_at, created_at, updated_at
      `)
      const row = rowsOf(result)[0]
      return row ? (row as unknown as ConversationRow) : null
    },

    async findIdByListingAndBuyer(listingId, buyerId) {
      const result = await db.execute(
        sql`SELECT id FROM conversations WHERE listing_id = ${listingId} AND buyer_id = ${buyerId}`,
      )
      const row = rowsOf(result)[0]
      return row ? (row.id as string) : null
    },

    async findDetail(conversationId, viewerId) {
      const result = await db.execute(sql`
        ${detailSelect(viewerId)}
        WHERE c.id = ${conversationId} AND (${viewerId} IN (c.buyer_id, c.seller_id))
      `)
      const row = rowsOf(result)[0]
      return row ? toDetailRow(row) : null
    },

    async listForUser(viewerId, { limit, cursor }) {
      // 子查询按 (last_message_at, id) DESC 取 limit+1 行；游标条件用行值比较，
      // 同一 last_message_at 的会话靠 id 决出稳定顺序（契约的 tie-break 口径）。
      const cursorCondition = cursor
        ? sql`AND (c.last_message_at, c.id) < (${cursor.sortKey}::timestamptz, ${cursor.id}::uuid)`
        : sql``
      const result = await db.execute(sql`
        SELECT * FROM (
          ${detailSelect(viewerId)}
          WHERE (c.buyer_id = ${viewerId} OR c.seller_id = ${viewerId}) ${cursorCondition}
          ORDER BY c.last_message_at DESC, c.id DESC
          LIMIT ${limit + 1}
        ) page
      `)
      return rowsOf(result).map(toDetailRow)
    },

    async countUnread(viewerId) {
      // 不带 LIMIT：这正是本端点存在的理由——列表只取一页，>limit 的会话会漏计。
      // 与 detailSelect 的 unread_count 子查询共用 unreadMessagePredicate，两者恒等。
      const result = await db.execute(sql`
        SELECT count(*)::int AS unread_count
        FROM conversations c
        JOIN messages m ON m.conversation_id = c.id
        WHERE (c.buyer_id = ${viewerId} OR c.seller_id = ${viewerId})
          AND ${unreadMessagePredicate(viewerId)}
      `)
      return Number(rowsOf(result)[0]?.unread_count ?? 0)
    },

    async coverObjectKeys(listingIds) {
      // 无图商品也显式置 null（而不是缺失键）：调用方语义是"查过、没有"，不是"没查"。
      const map = new Map<string, string | null>(listingIds.map((id) => [id, null]))
      if (listingIds.length === 0) return map
      const result = await db.execute(sql`
        SELECT li.listing_id, li.object_key
        FROM listing_images li
        WHERE li.listing_id IN (${sql.join(
          listingIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
          -- 只认 0 号图（#6 契约 §1「下标即 sortOrder，0 = 封面」）。取"最小 sort_order"
          -- 会在缺少 0 号图的脏数据下把非封面图当封面，与 listings feed / profile 分叉
          -- （#40/F3）。(listing_id, sort_order) 有唯一索引，因此每个商品至多一行，
          -- 这里不再需要 DISTINCT ON / ORDER BY。
          AND li.sort_order = 0
      `)
      for (const row of rowsOf(result)) map.set(row.listing_id as string, row.object_key as string)
      return map
    },

    async markRead(conversationId, viewerId) {
      // 只推进查看者一侧的 last_read_at；updated_at 一并 bump（app 侧维护的约定）。
      // RETURNING 用于区分"没这个会话/不是参与者"与"已推进"。
      // GREATEST 是单调保护：now() 是**事务开始时刻**，两个并发 read 若「事务开始序」与
      // 「行锁获取序」相反，后拿到锁的那个会写进更早的时间戳，让读位倒退（#151）。
      // 由此也要求调用方不要把 markRead 包进长事务（读位会停在事务开始那一刻）；
      // 当前调用链是独立 HTTP 请求，每语句一个隐式事务，不受影响。
      const updated = await db.execute(sql`
        UPDATE conversations SET
          buyer_last_read_at = CASE WHEN buyer_id = ${viewerId}
            THEN GREATEST(COALESCE(buyer_last_read_at, 'epoch'::timestamptz), now())
            ELSE buyer_last_read_at END,
          seller_last_read_at = CASE WHEN seller_id = ${viewerId}
            THEN GREATEST(COALESCE(seller_last_read_at, 'epoch'::timestamptz), now())
            ELSE seller_last_read_at END,
          updated_at = now()
        WHERE id = ${conversationId} AND ${viewerId} IN (buyer_id, seller_id)
        RETURNING id
      `)
      if (rowsOf(updated).length === 0) return null
      return this.findDetail(conversationId, viewerId)
    },
  }
}
