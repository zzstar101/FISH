import { notificationTypeSchema } from '@fish/contracts/notifications/schema'
import type { Db } from '@fish/db/client'
import { notifications } from '@fish/db/schema/notifications'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'

/**
 * 通知持久化接口。表与索引由 #2 冻结（`packages/db/src/schema/notifications.ts`），
 * 本域只读 + 改写 `read_at`，不新增列。
 *
 * 读/写用 drizzle 的 typed builder 而不是裸 `db.execute`：`payload` 是 jsonb，
 * 裸 SQL 在 bun-sql 下回的是**字符串**（实测），typed builder 才按列类型解析成对象。
 */

/** 通知行。`payload` 保持 `unknown`：jsonb 是自由形状，投影成契约 DTO 由 service 负责。 */
export interface NotificationRow {
  id: string
  type: string
  payload: unknown
  read_at: Date | null
  created_at: Date
}

export interface NotificationStore {
  /** 本人的通知，`created_at DESC, id DESC`，封顶 `limit`。 */
  listByUser(userId: string, limit: number): Promise<NotificationRow[]>
  /** 本人未读数（`read_at IS NULL`）。 */
  countUnread(userId: string): Promise<number>
  /**
   * 标记为已读并返回该行；**不存在、不是本人的、或 type 不在契约里的返回 null**
   * （由 service 映射 404，且这三种情形**都不写库**）。
   * `user_id` 写进 WHERE 而不是先查后写：既没有 TOCTOU，也不泄漏他人 id 是否存在。
   *
   * `COALESCE(read_at, ...)` 让重复调用不再改写时间戳——幂等在**数据层**成立，
   * 而不只是「状态码还是 200」。
   */
  markRead(id: string, userId: string, readAt: Date): Promise<NotificationRow | null>
}

/**
 * 「这一行的 type 能被契约表示」的 SQL 谓词。**值域来自契约本身**
 * （`notificationTypeSchema.options`），不在这里重写一份 type 列表：P1 往契约里加
 * 降价通知时，列表与角标自动跟着放开，没有第二处需要同步的真相。
 *
 * 为什么必须在 SQL 里过滤而不是只在 JS 里跳过（#23 评审 F1）：`LIMIT` 在 SQL 阶段生效，
 * JS 侧丢行会让**不可展示的行占掉名额**——一行脏数据 + 一行正常数据时
 * `?limit=1` 会返回空页，用户明明有可展示的未读通知；未读数也会与列表给出两个答案。
 * 库里 `type` 是裸 `text`、无 CHECK（`schema/notifications.ts:6` 写明值集未冻结），
 * 所以契约枚举是唯一能收窄它的地方。
 */
const projectableType = inArray(notifications.type, [...notificationTypeSchema.options])

/** 只取契约会用到的五列（不返回 `user_id`：调用方已经知道是谁的）。 */
const notificationColumns = {
  id: notifications.id,
  type: notifications.type,
  payload: notifications.payload,
  read_at: notifications.readAt,
  created_at: notifications.createdAt,
}

export function createSqlNotificationStore(db: Db): NotificationStore {
  return {
    async listByUser(userId, limit) {
      // 排序方向与 `notifications_user_id_created_at_idx` 同向；`id` 兜底让同一
      // `created_at` 的多行顺序稳定（否则同秒写入的两条通知在两次请求里可能换位）。
      return db
        .select(notificationColumns)
        .from(notifications)
        .where(and(eq(notifications.userId, userId), projectableType))
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(limit)
    },

    async countUnread(userId) {
      // 走 `notifications_user_id_unread_idx`（部分索引 `WHERE read_at IS NULL`），
      // 这也是 #23 要求「未读数单独端点」的底气：它不扫列表。
      // 与 listByUser 共用 projectableType：角标恒等于列表能展示的未读条数。
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(notifications)
        .where(and(eq(notifications.userId, userId), isNull(notifications.readAt), projectableType))
      return Number(rows[0]?.count ?? 0)
    },

    async markRead(id, userId, readAt) {
      // 同一个 projectableType 也在这里：否则会出现「响应说 404、库里 read_at 已被改」——
      // 一条自相矛盾的 404（重试仍然 404，但角标已经掉了一个）。一行 WHERE 就能让 404 零写入。
      const rows = await db
        .update(notifications)
        .set({ readAt: sql`coalesce(${notifications.readAt}, ${readAt})` })
        .where(and(eq(notifications.id, id), eq(notifications.userId, userId), projectableType))
        .returning(notificationColumns)
      return rows[0] ?? null
    },
  }
}
