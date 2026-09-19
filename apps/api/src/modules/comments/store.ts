import type { Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { comments } from '@fish/db/schema/comments'
import { listings } from '@fish/db/schema/listings'
import { users } from '@fish/db/schema/users'
import { and, asc, desc, eq, inArray, isNull, lt, or, type SQL, sql } from 'drizzle-orm'

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
  }
}
