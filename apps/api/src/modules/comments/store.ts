import type { Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { comments } from '@fish/db/schema/comments'
import { listings } from '@fish/db/schema/listings'
import { users } from '@fish/db/schema/users'
import { and, asc, desc, eq, inArray, isNull, lt, or, type SQL, sql } from 'drizzle-orm'
import type { ListingCardSource } from '../listings/card'

/**
 * 留言持久化。表由 #111 新建（`packages/db/src/schema/comments.ts`）。
 *
 * 时间戳一律用 `to_char(..., 'US')` 单独取一份**微秒精度**文本供游标使用：
 * `createdAt`（JS `Date`）只有毫秒，用 `toISOString()` 生成的游标会让同一毫秒内的
 * 边界行在翻页时被跳过（与 listings feed 同一个已踩过的坑）。
 */
export interface CommentRow {
  id: string
  listingId: string
  authorId: string
  parentId: string | null
  content: string
  createdAt: Date
  /** 微秒精度的 `created_at` 文本，仅用于构造游标。 */
  createdAtCursor: string
  authorNickname: string
  authorAvatarUrl: string | null
}

/** 游标在 store 层是**已解码**结构；类型由 service 校验后才走到这里。 */
export type CommentCursor = { createdAt: string; id: string }

/**
 * 「我发过的留言」一行（#195）：留言字段 + 它所在商品的**卡片源**（供共享投影 `toListingCard`）。
 *
 * 为什么把商品列平铺进同一个 row 而不是另查一次：一行一次 join 就能同时给出留言与卡片，
 * 逐条回查商品详情是 N+1，而「遍历自己的商品再查留言」还会漏掉别人商品下的留言。
 * `id` 是**商品** id（`ListingCardSource` 的约定），留言 id 在 `commentId`。
 */
export interface MyCommentRow extends ListingCardSource {
  commentId: string
  commentParentId: string | null
  commentContent: string
  /** 毫秒 ISO，直接进契约（不经过 `Date`，避免精度与时区干扰）。 */
  commentCreatedAt: string
  /** 微秒 ISO，仅用于构造游标。 */
  commentCreatedAtCursor: string
  coverObjectKey: string | null
}

export interface CommentStore {
  /** 该商品是否存在、卖家是谁（`isSeller` 判定要用）。不存在返回 null。 */
  findListingSellerId(listingId: string): Promise<string | null>
  /**
   * 取一页**顶层**留言（`parent_id IS NULL`），`created_at DESC, id DESC`，多取一行由
   * 调用方判断 `hasMore`。
   */
  listTopLevel(
    listingId: string,
    limit: number,
    cursor: CommentCursor | null,
  ): Promise<CommentRow[]>
  /** 取给定顶层留言的全部回复，`created_at ASC, id ASC`（回复按时间正序读）。 */
  listReplies(parentIds: string[]): Promise<CommentRow[]>
  /** 按 id 取单条（带作者信息）。 */
  findById(id: string): Promise<CommentRow | null>
  /** 插入一条留言（顶层或回复）。返回新行 id。 */
  insert(input: {
    listingId: string
    authorId: string
    parentId: string | null
    content: string
  }): Promise<string>
  /**
   * 我发过的留言（#195），`created_at DESC, id DESC`，**多取一行由调用方判断 hasMore**
   * （与 `listTopLevel` 同款：调用方传 `limit + 1`）。
   */
  listByAuthor(
    authorId: string,
    limit: number,
    cursor: CommentCursor | null,
  ): Promise<MyCommentRow[]>
  /** 我发过的留言总数（全量，与 `listByAuthor` 同一作者条件）。 */
  countByAuthor(authorId: string): Promise<number>
  /** 某条留言下的回复数（仅顶层留言会有；级联删除时用来回报真实删除条数）。 */
  countReplies(parentId: string): Promise<number>
  /** 删除**自己的**某条留言，返回实际删除行数（0 = 不存在或不是自己的）。 */
  deleteOwn(authorId: string, commentId: string): Promise<number>
}

/**
 * 行投影：作者昵称 / 头像来自 `users`，`avatarUrl` 保持 `text | null`，
 * 值域降级由 service 负责（库里是无约束 text）。
 */
const rowColumns = {
  id: comments.id,
  listingId: comments.listingId,
  authorId: comments.authorId,
  parentId: comments.parentId,
  content: comments.content,
  createdAt: comments.createdAt,
  createdAtCursor: sql<string>`to_char(${comments.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  authorNickname: users.nickname,
  authorAvatarUrl: users.avatarUrl,
} as const

/**
 * 「我发过的留言」的行投影：商品列（卡片源）+ 留言列。
 *
 * 封面只认 `sort_order = 0`（#6 契约 §1：下标即 sortOrder），取不到就是 `null`，
 * 与 listings feed / matching / profile / favorites 同一口径。
 */
const myCommentColumns = {
  id: listings.id,
  listingNo: listings.listingNo,
  title: listings.title,
  priceCents: listings.priceCents,
  category: listings.category,
  condition: listings.condition,
  status: listings.status,
  urgent: listings.urgent,
  negotiable: listings.negotiable,
  free: listings.free,
  createdAt: listings.createdAt,
  // 卖家公开子集（#191 的 `ListingCardSource.seller`，本 PR 补齐）：与 feed / 详情 / 收藏
  // 同一 inner join 同源投影 —— 「我发过的留言」里每张卡片也要能直接渲染卖家（昵称 / 头像 /
  // 认证态），不逐卡补查。`listings.seller_id` 外键保证行存在，PK join 是 1:1，
  // 不影响分页、游标与排序。
  seller: {
    id: users.id,
    nickname: users.nickname,
    avatarUrl: users.avatarUrl,
    authStatus: users.authStatus,
  },
  coverObjectKey: sql<
    string | null
  >`(SELECT li.object_key FROM listing_images li WHERE li.listing_id = ${listings.id} AND li.sort_order = 0 LIMIT 1)`,
  commentId: comments.id,
  commentParentId: comments.parentId,
  commentContent: comments.content,
  commentCreatedAt: sql<string>`to_char(${comments.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
  commentCreatedAtCursor: sql<string>`to_char(${comments.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
} as const

/** 游标条件：`(created_at, id) < (cursor.createdAt, cursor.id)`，与 `created_at DESC, id DESC` 同向。 */
function cursorCondition(cursor: CommentCursor): SQL {
  return or(
    // 文本 + `::timestamptz` 保留微秒，比较仍能落在 `comments_listing_id_parent_id_created_at_id_idx` 上。
    sql`${comments.createdAt} < ${cursor.createdAt}::timestamptz`,
    and(sql`${comments.createdAt} = ${cursor.createdAt}::timestamptz`, lt(comments.id, cursor.id)),
  ) as SQL
}

export function createSqlCommentStore(db: Db): CommentStore {
  return {
    async findListingSellerId(listingId) {
      const rows = await db
        .select({ sellerId: listings.sellerId })
        .from(listings)
        .where(eq(listings.id, listingId))
        .limit(1)
      return rows[0]?.sellerId ?? null
    },

    async listTopLevel(listingId, limit, cursor) {
      const conditions: SQL[] = [eq(comments.listingId, listingId), isNull(comments.parentId)]
      if (cursor) conditions.push(cursorCondition(cursor))

      return db
        .select(rowColumns)
        .from(comments)
        .innerJoin(users, eq(users.id, comments.authorId))
        .where(and(...conditions))
        .orderBy(desc(comments.createdAt), desc(comments.id))
        .limit(limit)
    },

    async listReplies(parentIds) {
      if (parentIds.length === 0) return []
      return db
        .select(rowColumns)
        .from(comments)
        .innerJoin(users, eq(users.id, comments.authorId))
        .where(inArray(comments.parentId, parentIds))
        .orderBy(asc(comments.createdAt), asc(comments.id))
    },

    async findById(id) {
      const rows = await db
        .select(rowColumns)
        .from(comments)
        .innerJoin(users, eq(users.id, comments.authorId))
        .where(eq(comments.id, id))
        .limit(1)
      return rows[0] ?? null
    },

    async insert(input) {
      const id = newId()
      await db.insert(comments).values({
        id,
        listingId: input.listingId,
        authorId: input.authorId,
        parentId: input.parentId,
        content: input.content,
      })
      return id
    },

    async listByAuthor(authorId, limit, cursor) {
      const conditions: SQL[] = [eq(comments.authorId, authorId)]
      if (cursor) conditions.push(cursorCondition(cursor))

      return db
        .select(myCommentColumns)
        .from(comments)
        .innerJoin(listings, eq(listings.id, comments.listingId))
        .innerJoin(users, eq(users.id, listings.sellerId))
        .where(and(...conditions))
        .orderBy(desc(comments.createdAt), desc(comments.id))
        .limit(limit)
    },

    async countByAuthor(authorId) {
      const rows = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(comments)
        .where(eq(comments.authorId, authorId))
      return Number(rows[0]?.total ?? 0)
    },

    async countReplies(parentId) {
      const rows = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(comments)
        .where(eq(comments.parentId, parentId))
      return Number(rows[0]?.total ?? 0)
    },

    async deleteOwn(authorId, commentId) {
      // `author_id` 写进 WHERE 而不是先查后删：一次往返、原子，且天然把「不是自己的」挡在
      // 影响行数之外。返回行数即真实删除数（被级联删掉的回复不在 `RETURNING` 里，
      // 由 service 单独统计，见 `CommentDeleteResponseSchema` 的注释）。
      const rows = await db
        .delete(comments)
        .where(and(eq(comments.id, commentId), eq(comments.authorId, authorId)))
        .returning({ id: comments.id })
      return rows.length
    },
  }
}
