import type { Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { transactionReviewImages, transactionReviews } from '@fish/db/schema/transaction-reviews'
import { and, eq, inArray, or, type SQL, sql } from 'drizzle-orm'

/**
 * 交易评价的持久化（#195 PR2）。表与索引由 #287 落地（`packages/db/src/schema/transaction-reviews.ts`）。
 *
 * ## 「参与者 / COMPLETED / 各方一条」的分工
 *
 * DB 只保证「同一作者对同一交易最多一条」（`(transaction_id, author_id)` 唯一索引）；
 * 「作者是本笔交易的参与者」「交易必须 COMPLETED」是跨表条件，CHECK 表达不了，
 * 由 service 先查后写（见 service 层），唯一冲突（23505）由 `ON CONFLICT DO NOTHING`
 * 落成「插不进去」再翻成 409，而不是让并发重复请求变成 500。
 *
 * ## 时间戳与游标
 *
 * 与 comments store 同一个坑：JS `Date` 只有毫秒，游标要吃
 * `to_char(..., 'US')` 的**微秒**文本；`(author_id, created_at, id)` 索引就是为这条
 * 时间线准备的（#287 落的第三条索引）。
 */

/** 时间戳统一取两份：毫秒 ISO 进契约，微秒 ISO 构造游标。列名固定走 `r.` 别名。 */
const REVIEW_TIME_COLUMNS = sql`
  to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_iso,
  to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor`

export interface ReviewRow {
  id: string
  rating: string
  body: string | null
  /** 毫秒 ISO，直接进契约（不经过 `Date`，避免精度与时区干扰）。 */
  createdAt: string
  /** 微秒 ISO，仅用于构造游标。 */
  createdAtCursor: string
}

export interface MyReviewRow extends ReviewRow {
  imageKeys: string[]
}

/**
 * 「我发过的评价」时间线一行：评价 + 所属交易的**订单 DTO 源**。
 *
 * 交易/商品/对方用户三段平铺进同一个 row：一行一次 join 同时给出评价与订单卡，
 * 端上行点击进订单详情（真实 `transactionId`）或商品（真实 `listingId`），不靠标题猜 ID，
 * 也不逐行回查（N+1）。查看者恒为评价作者本人，`counterpart` 由 buyer/seller 二选一。
 */
export interface ReviewTimelineRow extends MyReviewRow {
  transaction: {
    id: string
    /** 会话 id（join conversations 取得）；FK 一致的数据恒有值，null 行由映射层跳过。 */
    conversationId: string | null
    listingId: string
    buyerId: string
    sellerId: string
    amountCents: number
    status: string
    buyerConfirmedAt: string | null
    sellerConfirmedAt: string | null
    completedAt: string | null
    cancelledAt: string | null
    createdAt: string
    updatedAt: string
    listingTitle: string
    listingPriceCents: number
    listingStatus: string
    coverObjectKey: string | null
    counterpartId: string
    counterpartNickname: string
    counterpartAvatarUrl: string | null
  }
}

/** 一笔交易下的一条评价 + 谁写的（`GET /transactions/:id/reviews`，≤2 行不分页）。 */
export interface TransactionReviewRow extends MyReviewRow {
  authorRole: 'buyer' | 'seller'
}

export interface TransactionReviewsStore {
  /** 交易存在且查看者是它的 buyer/seller → 交易行；否则 null（404 语义，不区分不存在）。 */
  transactionForParticipant(
    transactionId: string,
    viewerId: string,
  ): Promise<{ id: string; status: string } | null>
  /** 我在这笔交易下的评价；没有 → null。 */
  findMyReview(transactionId: string, authorId: string): Promise<MyReviewRow | null>
  /**
   * 插入我的评价。`(transaction_id, author_id)` 冲突 → null（调用方翻 409），
   * 不做先读后写 —— 并发的第二个请求必须撞索引而不是撞竞态。
   */
  /** #475：同事务写评价 + 配图（冲突时返回 null 且不留图行）。 */
  insertReviewWithImages(input: {
    transactionId: string
    authorId: string
    rating: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE'
    body: string | null
    imageKeys: string[]
  }): Promise<MyReviewRow | null>
  insertReview(input: {
    transactionId: string
    authorId: string
    rating: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE'
    body: string | null
  }): Promise<MyReviewRow | null>
  /** 删除我在这笔交易下的评价，返回实际删除行数（0 = 本来就没有，幂等）。 */
  deleteOwnReview(transactionId: string, authorId: string): Promise<number>
  /** 一笔交易的两方评价（各 0..1 行，`authorRole` 由 buyer/seller 比较得出）。 */
  listReviewsOf(transactionId: string): Promise<TransactionReviewRow[]>
  /** 「我发过的评价」时间线（`created_at DESC, id DESC`，多取一行由调用方判 hasMore）。 */
  listByAuthor(
    authorId: string,
    limit: number,
    cursor: { createdAt: string; id: string } | null,
  ): Promise<ReviewTimelineRow[]>
  /** 本人评价全量条数（`total` 与列表同源，分段胶囊要用）。 */
  countByAuthor(authorId: string): Promise<number>
}

/** 评价行公共列（三处 raw SQL 共用；别名固定为 `r`）。 */
const REVIEW_COLUMNS = sql`
  r.id, r.rating::text AS rating, r.body, ${REVIEW_TIME_COLUMNS}`

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}

function myReviewRowOf(row: Record<string, unknown>, imageKeys: string[]): MyReviewRow {
  return {
    id: row.id as string,
    rating: row.rating as string,
    body: (row.body as string | null) ?? null,
    createdAt: row.created_at_iso as string,
    createdAtCursor: row.created_at_cursor as string,
    imageKeys,
  }
}

function cursorCondition(cursor: { createdAt: string; id: string }): SQL {
  return or(
    sql`r.created_at < ${cursor.createdAt}::timestamptz`,
    and(sql`r.created_at = ${cursor.createdAt}::timestamptz`, sql`r.id < ${cursor.id}::uuid`),
  ) as SQL
}

/** 配图键按 review 聚合（`sort_order` 升序 = 展示顺序）。 */
async function imageKeysByReview(db: Db, reviewIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>()
  if (reviewIds.length === 0) return map
  const rows = await db
    .select({
      reviewId: transactionReviewImages.reviewId,
      objectKey: transactionReviewImages.objectKey,
    })
    .from(transactionReviewImages)
    .where(inArray(transactionReviewImages.reviewId, reviewIds))
    .orderBy(transactionReviewImages.reviewId, transactionReviewImages.sortOrder)
  for (const row of rows) {
    const keys = map.get(row.reviewId)
    if (keys) keys.push(row.objectKey)
    else map.set(row.reviewId, [row.objectKey])
  }
  return map
}

export function createSqlTransactionReviewStore(db: Db): TransactionReviewsStore {
  /**
   * #475：评价行 + 配图行**同一事务**写入。冲突（已评过）时整事务回滚 —— 不会留下
   * 只挂了图没有评价的孤儿行。`sort_order` 取数组下标（0 = 第一张，与契约注释一致）。
   */
  async function insertReviewWithImages(input: {
    transactionId: string
    authorId: string
    rating: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE'
    body: string | null
    imageKeys: string[]
  }): Promise<MyReviewRow | null> {
    return db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        INSERT INTO transaction_reviews (id, transaction_id, author_id, rating, body)
        VALUES (${newId()}::uuid, ${input.transactionId}::uuid, ${input.authorId}::uuid,
                ${input.rating}::transaction_review_rating, ${input.body})
        ON CONFLICT (transaction_id, author_id) DO NOTHING
        RETURNING id, rating::text AS rating, body, ${sql`
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_iso,
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor`}
      `)
      const row = rowsOf(result)[0]
      if (!row) return null
      for (const [index, objectKey] of input.imageKeys.entries()) {
        await tx.execute(sql`
          INSERT INTO transaction_review_images (id, review_id, object_key, sort_order)
          VALUES (${newId()}::uuid, ${row.id as string}::uuid, ${objectKey}, ${index})
        `)
      }
      return myReviewRowOf(row, input.imageKeys)
    })
  }

  return {
    async transactionForParticipant(transactionId, viewerId) {
      const result = await db.execute(sql`
        SELECT t.id, t.status::text AS status
        FROM transactions t
        WHERE t.id = ${transactionId}::uuid
          AND (${viewerId}::uuid IN (t.buyer_id, t.seller_id))
      `)
      const row = rowsOf(result)[0]
      return row ? { id: row.id as string, status: row.status as string } : null
    },

    async findMyReview(transactionId, authorId) {
      const result = await db.execute(sql`
        SELECT ${REVIEW_COLUMNS}
        FROM transaction_reviews r
        WHERE r.transaction_id = ${transactionId}::uuid
          AND r.author_id = ${authorId}::uuid
      `)
      const row = rowsOf(result)[0]
      if (!row) return null
      const images = await imageKeysByReview(db, [row.id as string])
      return myReviewRowOf(row, images.get(row.id as string) ?? [])
    },

    async insertReview(input) {
      return insertReviewWithImages({ ...input, imageKeys: [] })
    },

    /**
     * #475：评价行 + 配图行**同一事务**写入。冲突（已评过）时整事务回滚 —— 不会留下
     * 只挂了图没有评价的孤儿行。`sort_order` 取数组下标（0 = 第一张，与契约注释一致）。
     */
    insertReviewWithImages,

    async deleteOwnReview(transactionId, authorId) {
      const rows = await db
        .delete(transactionReviews)
        .where(
          and(
            eq(transactionReviews.transactionId, transactionId),
            eq(transactionReviews.authorId, authorId),
          ),
        )
        .returning({ id: transactionReviews.id })
      return rows.length
    },

    async listReviewsOf(transactionId) {
      const result = await db.execute(sql`
        SELECT ${REVIEW_COLUMNS},
               (r.author_id = t.buyer_id) AS is_buyer
        FROM transaction_reviews r
        JOIN transactions t ON t.id = r.transaction_id
        WHERE r.transaction_id = ${transactionId}::uuid
        ORDER BY r.created_at ASC
      `)
      const rows = rowsOf(result)
      const images = await imageKeysByReview(
        db,
        rows.map((row) => row.id as string),
      )
      return rows.map((row) => ({
        ...myReviewRowOf(row, images.get(row.id as string) ?? []),
        authorRole: row.is_buyer ? ('buyer' as const) : ('seller' as const),
      }))
    },

    async listByAuthor(authorId, limit, cursor) {
      const conditions: SQL[] = [sql`r.author_id = ${authorId}::uuid`]
      if (cursor) conditions.push(cursorCondition(cursor))
      const result = await db.execute(sql`
        SELECT ${REVIEW_COLUMNS},
               t.id AS t_id, c.id AS conversation_id, t.listing_id, t.buyer_id, t.seller_id,
               t.amount_cents, t.status::text AS t_status,
               to_char(t.buyer_confirmed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t_buyer_confirmed_at,
               to_char(t.seller_confirmed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t_seller_confirmed_at,
               to_char(t.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t_completed_at,
               to_char(t.cancelled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t_cancelled_at,
               to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t_created_at,
               to_char(t.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t_updated_at,
               l.title AS l_title, l.price_cents AS l_price_cents, l.status::text AS l_status,
               li.object_key AS cover_object_key,
               cu.id AS cu_id, cu.nickname AS cu_nickname, cu.avatar_url AS cu_avatar_url
        FROM transaction_reviews r
        JOIN transactions t ON t.id = r.transaction_id
        JOIN listings l ON l.id = t.listing_id
        JOIN users cu ON cu.id = CASE WHEN r.author_id = t.buyer_id THEN t.seller_id ELSE t.buyer_id END
        -- 会话与交易一一对应（accept 流程同事务创建），join 条件与 transactions/store.ts 同一门槛
        LEFT JOIN conversations c
          ON c.listing_id = t.listing_id AND c.buyer_id = t.buyer_id AND c.seller_id = t.seller_id
        LEFT JOIN LATERAL (
          -- 只认 0 号图（#6 契约 §1「0 = 封面」，与 transactions / profile 同一口径）
          SELECT object_key FROM listing_images
          WHERE listing_id = l.id AND sort_order = 0
          LIMIT 1
        ) li ON TRUE
        WHERE ${and(...conditions)}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ${limit}
      `)
      const rows = rowsOf(result)
      const images = await imageKeysByReview(
        db,
        rows.map((row) => row.id as string),
      )
      return rows.map((row) => ({
        ...myReviewRowOf(row, images.get(row.id as string) ?? []),
        transaction: {
          id: row.t_id as string,
          conversationId: (row.conversation_id as string | null) ?? null,
          listingId: row.listing_id as string,
          buyerId: row.buyer_id as string,
          sellerId: row.seller_id as string,
          amountCents: row.amount_cents as number,
          status: row.t_status as string,
          buyerConfirmedAt: row.t_buyer_confirmed_at as string | null,
          sellerConfirmedAt: row.t_seller_confirmed_at as string | null,
          completedAt: row.t_completed_at as string | null,
          cancelledAt: row.t_cancelled_at as string | null,
          createdAt: row.t_created_at as string,
          updatedAt: row.t_updated_at as string,
          listingTitle: row.l_title as string,
          listingPriceCents: row.l_price_cents as number,
          listingStatus: row.l_status as string,
          coverObjectKey: (row.cover_object_key as string | null) ?? null,
          counterpartId: row.cu_id as string,
          counterpartNickname: row.cu_nickname as string,
          counterpartAvatarUrl: (row.cu_avatar_url as string | null) ?? null,
        },
      }))
    },

    async countByAuthor(authorId) {
      const rows = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(transactionReviews)
        .where(eq(transactionReviews.authorId, authorId))
      return Number(rows[0]?.total ?? 0)
    },
  }
}
