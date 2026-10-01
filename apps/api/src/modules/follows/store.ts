import type { AuthStatus } from '@fish/contracts/auth/user'
import type { Db } from '@fish/db/client'
import { follows } from '@fish/db/schema/follows'
import { users } from '@fish/db/schema/users'
import { and, desc, eq, lt, or, type SQL, sql } from 'drizzle-orm'

/**
 * 关注关系的持久化（Issue #188）。表由 #287 落地（`packages/db/src/schema/follows.ts`）。
 *
 * ## 幂等靠 DB 唯一约束，不靠先读后写
 *
 * `POST /users/:userId/follow` 用 `ON CONFLICT DO NOTHING`、`DELETE` 用无条件删——
 * 两者都不需要「先查有没有」。先读后写在并发下会漏（两个请求同时读到"没有"，
 * 一个插入成功、另一个撞 23505 变成 500）。
 *
 * ## 公开投影落在**列投影**上
 *
 * `listFollowing` 只 SELECT `users` 的公开列（`nickname / avatar_url / auth_status`）——
 * `student_no` / `campus_email` / `password_hash` / `role` 连查都不查。与 `users/store.ts`
 * 同一条约束：「不泄漏」靠的是没查，不是查了再删。
 *
 * ## 排序与索引
 *
 * `(created_at DESC, 用户 id DESC)`：`follows_follower_id_created_at_id_idx`
 * 覆盖 `(follower_id, created_at)` 前缀，末列的 tie-break 用**用户 id** 而不是 follows.id，
 * 是为了让游标里承载的是 `usr_` Public ID（与全仓游标约定一致），不是内部行 id。
 * 同一 `created_at` 的分组通常极小，末列排序代价可忽略；顺序是全序（用户 id 唯一），
 * 所以 `(created_at, id)` 游标不重不漏。
 */
export interface FollowingRow {
  id: string
  nickname: string
  avatarUrl: string | null
  authStatus: AuthStatus
  mutual: boolean
  /** 微秒精度的 `follows.created_at` UTC ISO 文本，仅供构造游标。 */
  followedAtCursor: string
}

export interface FollowingTotals {
  /** 我关注的总人数（全量，不是这一页）。 */
  total: number
  /** 其中互相关注的人数。 */
  mutualTotal: number
}

export type FollowingCursor = { createdAt: string; id: string }

export interface FollowStore {
  /** 目标用户是否存在（不存在 → 404，不泄漏"格式错"与"不存在"的差异）。 */
  userExists(userId: string): Promise<boolean>
  /** 我关注的人，多取一行由调用方判断还有没有下一页。 */
  listFollowing(
    followerId: string,
    limit: number,
    cursor: FollowingCursor | null,
  ): Promise<FollowingRow[]>
  /** 全量计数，与 `listFollowing` 同一张表、同一个方向。 */
  totals(followerId: string): Promise<FollowingTotals>
  /** 我是否关注了 TA。 */
  isFollowing(followerId: string, followingId: string): Promise<boolean>
  /** 幂等关注（已存在则不动，不改写首次 created_at）。 */
  follow(followerId: string, followingId: string): Promise<void>
  /** 幂等取关（不存在也是成功）。 */
  unfollow(followerId: string, followingId: string): Promise<void>
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}

/**
 * 互关判定：反向那条边是否存在。相关子查询引用**外层** `follows` 的列，内层别名 `back`
 * 避免自引用歧义（`listings/store.ts` 踩过未限定列名被静默解析到错误作用域的坑）。
 */
function mutualExpr(): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM follows back
    WHERE back.follower_id = ${follows.followingId}
      AND back.following_id = ${follows.followerId}
  )`
}

/** `(created_at, 用户 id) < (cursor)`，与 `created_at DESC, id DESC` 同向。 */
function cursorCondition(cursor: FollowingCursor): SQL {
  return or(
    sql`${follows.createdAt} < ${cursor.createdAt}::timestamptz`,
    and(sql`${follows.createdAt} = ${cursor.createdAt}::timestamptz`, lt(users.id, cursor.id)),
  ) as SQL
}

export function createSqlFollowStore(db: Db): FollowStore {
  return {
    async userExists(userId) {
      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
      return rows.length > 0
    },

    async listFollowing(followerId, limit, cursor) {
      const conditions: SQL[] = [eq(follows.followerId, followerId)]
      if (cursor) conditions.push(cursorCondition(cursor))

      return (
        db
          .select({
            id: follows.followingId,
            nickname: users.nickname,
            avatarUrl: users.avatarUrl,
            authStatus: users.authStatus,
            mutual: mutualExpr(),
            followedAtCursor: sql<string>`to_char(${follows.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          })
          .from(follows)
          .innerJoin(users, eq(users.id, follows.followingId))
          .where(and(...conditions))
          .orderBy(desc(follows.createdAt), desc(users.id))
          // 多取一行用于判断"还有没有下一页"，返回前丢掉（与 listings feed 同款）。
          .limit(limit + 1)
      )
    },

    async totals(followerId) {
      const result = await db.execute(sql`
        SELECT
          count(*)::int AS total,
          (count(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM follows back
            WHERE back.follower_id = follows.following_id
              AND back.following_id = follows.follower_id
          )))::int AS mutual_total
        FROM follows
        WHERE follows.follower_id = ${followerId}
      `)
      const row = rowsOf(result)[0]
      if (!row) throw new Error('关注统计查询未返回行')
      return { total: Number(row.total), mutualTotal: Number(row.mutual_total) }
    },

    async isFollowing(followerId, followingId) {
      const rows = await db
        .select({ id: follows.id })
        .from(follows)
        .where(and(eq(follows.followerId, followerId), eq(follows.followingId, followingId)))
        .limit(1)
      return rows.length > 0
    },

    async follow(followerId, followingId) {
      // `ON CONFLICT DO NOTHING` 命中 (follower_id, following_id) 唯一索引 → 幂等。
      await db.insert(follows).values({ followerId, followingId }).onConflictDoNothing()
    },

    async unfollow(followerId, followingId) {
      await db
        .delete(follows)
        .where(and(eq(follows.followerId, followerId), eq(follows.followingId, followingId)))
    },
  }
}
