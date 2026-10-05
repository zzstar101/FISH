import type { AuthStatus } from '@fish/contracts/auth/user'
import type { Db } from '@fish/db/client'
import { userBlocks } from '@fish/db/schema/blocks'
import { users } from '@fish/db/schema/users'
import { and, desc, eq, lt, or, type SQL, sql } from 'drizzle-orm'

/**
 * 拉黑关系的持久化（#466）。表：`packages/db/src/schema/blocks.ts` 的 `user_blocks`。
 *
 * ## 幂等靠 DB 唯一约束，不靠先读后写（follows 同款）
 *
 * `POST /users/:userId/block` 用 `ON CONFLICT DO NOTHING`、`DELETE` 用无条件删。
 *
 * ## 守卫查询是**双向**的
 *
 * `existsBlockBetween(a, b)` 判「任一方向存在拉黑边」：拉黑的生效语义是双向拦截
 * （既有会话双方都不能发消息、都不能新建会话），所以守卫只需要这一个谓词。
 * `(blocker_id, blocked_id)` 唯一索引 + `(blocked_id, blocker_id)` 组合条件让这条
 * 查询在两个方向都能吃索引。
 *
 * ## 并发口径（#466 验收「并发拉黑/发送与已有 WS 会话有一致定义」）
 *
 * 守卫是**每次发送前的一次独立读**，与消息落库不共享事务。定义如下（可在后续按 Owner
 * 口径收紧，当前实现即此语义）：
 * - 拉黑对**判定时刻之后开始**的发送生效：发送请求进入 service 后先读守卫，命中即 403；
 * - 在途消息（守卫读通过、正在落库）**不回收**：拉黑与在途写不互相阻塞，极端交错下
 *   可能有一条消息在拉黑建立的同时落库并已推送——不做回删、不补偿；
 * - 解除拉黑即刻恢复：守卫读不到边即放行，无需等任何缓存失效；
 * - WS 通道只收客户端 `ping`（realtimeClientEventSchema），发送全部走本守卫覆盖的
 *   HTTP 端点，因此「已有 WS 会话」不构成绕过路径。
 */
export interface BlockedRow {
  id: string
  nickname: string
  avatarUrl: string | null
  authStatus: AuthStatus
  /** 微秒精度的 `user_blocks.created_at` UTC ISO 文本，仅供构造游标。 */
  blockedAtCursor: string
}

export type BlockCursor = { createdAt: string; id: string }

/**
 * chat 域守卫需要的最小接口：只依赖「双向是否存在拉黑边」这一个谓词。
 * conversations / messages / media 三个 service 以**类型**依赖它（运行时实例由
 * `app.ts` 注入 `createSqlBlockStore(db)`），不跨模块直 import 实现文件。
 */
export interface BlockRelationCheck {
  existsBlockBetween(a: string, b: string): Promise<boolean>
}

export interface BlockStore {
  /** 目标用户是否存在（不存在 → 404，不泄漏「格式错」与「不存在」的差异）。 */
  userExists(userId: string): Promise<boolean>
  /** 我拉黑的人，多取一行由调用方判断还有没有下一页。 */
  listBlocks(blockerId: string, limit: number, cursor: BlockCursor | null): Promise<BlockedRow[]>
  /** 我是否拉黑了 TA（黑名单页与关系状态读用，单向）。 */
  isBlocked(blockerId: string, blockedId: string): Promise<boolean>
  /** **双向**守卫谓词：两人之间任一方向存在拉黑边即为 true。 */
  existsBlockBetween(a: string, b: string): Promise<boolean>
  /** 幂等拉黑（已存在则不动，不改写首次 created_at）。 */
  block(blockerId: string, blockedId: string): Promise<void>
  /** 幂等解除（不存在也是成功）。 */
  unblock(blockerId: string, blockedId: string): Promise<void>
}

/** `(created_at, 用户 id) < (cursor)`，与 `created_at DESC, id DESC` 同向。 */
function cursorCondition(cursor: BlockCursor): SQL {
  return or(
    sql`${userBlocks.createdAt} < ${cursor.createdAt}::timestamptz`,
    and(sql`${userBlocks.createdAt} = ${cursor.createdAt}::timestamptz`, lt(users.id, cursor.id)),
  ) as SQL
}

export function createSqlBlockStore(db: Db): BlockStore {
  return {
    async userExists(userId) {
      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
      return rows.length > 0
    },

    async listBlocks(blockerId, limit, cursor) {
      const conditions: SQL[] = [eq(userBlocks.blockerId, blockerId)]
      if (cursor) conditions.push(cursorCondition(cursor))

      return (
        db
          .select({
            id: userBlocks.blockedId,
            nickname: users.nickname,
            avatarUrl: users.avatarUrl,
            authStatus: users.authStatus,
            blockedAtCursor: sql<string>`to_char(${userBlocks.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          })
          .from(userBlocks)
          .innerJoin(users, eq(users.id, userBlocks.blockedId))
          .where(and(...conditions))
          .orderBy(desc(userBlocks.createdAt), desc(users.id))
          // 多取一行用于判断"还有没有下一页"，返回前丢掉（follows / feed 同款）。
          .limit(limit + 1)
      )
    },

    async isBlocked(blockerId, blockedId) {
      const rows = await db
        .select({ id: userBlocks.id })
        .from(userBlocks)
        .where(and(eq(userBlocks.blockerId, blockerId), eq(userBlocks.blockedId, blockedId)))
        .limit(1)
      return rows.length > 0
    },

    async existsBlockBetween(a, b) {
      const rows = await db
        .select({ id: userBlocks.id })
        .from(userBlocks)
        .where(
          or(
            and(eq(userBlocks.blockerId, a), eq(userBlocks.blockedId, b)),
            and(eq(userBlocks.blockerId, b), eq(userBlocks.blockedId, a)),
          ),
        )
        .limit(1)
      return rows.length > 0
    },

    async block(blockerId, blockedId) {
      // `ON CONFLICT DO NOTHING` 命中 (blocker_id, blocked_id) 唯一索引 → 幂等。
      await db.insert(userBlocks).values({ blockerId, blockedId }).onConflictDoNothing()
    },

    async unblock(blockerId, blockedId) {
      await db
        .delete(userBlocks)
        .where(and(eq(userBlocks.blockerId, blockerId), eq(userBlocks.blockedId, blockedId)))
    },
  }
}
