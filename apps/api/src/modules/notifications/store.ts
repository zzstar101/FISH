import {
  notificationPayloadSchema,
  notificationTypeSchema,
} from '@fish/contracts/notifications/schema'
import type { Db } from '@fish/db/client'
import { notifications } from '@fish/db/schema/notifications'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'

/**
 * 通知持久化接口。表与索引由 #2 冻结（`packages/db/src/schema/notifications.ts`），
 * 本域只读 + 改写 `read_at`，不新增列。
 *
 * 读/写用 drizzle 的 typed builder 而不是裸 `db.execute`：`payload` 是 jsonb，
 * 裸 SQL 在 bun-sql 下回的是**字符串**（实测），typed builder 才按列类型解析成对象。
 *
 * 三个方法都用同一个 `projectable` 谓词（见下）：**契约允许的行 = 能出现在列表、能计入角标、
 * 能被标记已读的行**，三者由 SQL 保证一致，service 里的投影校验只是纵深防御。
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
  /** 本人的通知，`created_at DESC, id DESC`，封顶 `limit`（`limit` 只数可行）。 */
  listByUser(userId: string, limit: number): Promise<NotificationRow[]>
  /** 本人未读数（`read_at IS NULL`，且与列表同一套可展示性判据）。 */
  countUnread(userId: string): Promise<number>
  /**
   * 标记为已读并返回该行；**不存在、不是本人的、或契约表示不了的返回 null**
   * （由 service 映射 404，且这些情形**都不写库**）。
   * `user_id` 写进 WHERE 而不是先查后写：既没有 TOCTOU，也不泄漏他人 id 是否存在。
   *
   * `COALESCE(read_at, ...)` 让重复调用不再改写时间戳——幂等在**数据层**成立，
   * 而不只是「状态码还是 200」。
   */
  markRead(id: string, userId: string, readAt: Date): Promise<NotificationRow | null>
}

/**
 * 「这一行能被契约表示」的 SQL 谓词，五条判据与契约**逐条对齐**，值域全部从契约派生
 * （enum 取值 + payload 的键名），不在这里重写第二份真相：P1 往契约里加降价通知，改枚举即可，
 * 列表 / 角标 / 标记已读三处自动同步。
 *
 * 1. `type` ∈ `notificationTypeSchema.options`（库里 `type` 是裸 `text`、无 CHECK）；
 * 2. `jsonb_typeof(payload) = 'object'`（契约要的是对象；jsonb 字符串/数组/标量都不行）；
 * 3. `isfinite(created_at)` —— PG 能存 `'infinity'::timestamptz`，而 JS 的 `Date` 表示不了；
 * 4. `read_at IS NULL OR isfinite(read_at)`（NULL = 未读，是合法状态）；
 * 5. `payload` 的三个可选键**存在时必须是字符串**（契约是 `z.string().optional()`：
 *    显式 `null` / 数字都不合法；键缺失才合法，所以判据是「不存在 **或** 是字符串」）。
 *
 * **为什么必须在 SQL 里收窄而不是只在 JS 里丢行**（#23 评审 F1/F1'）：`LIMIT` 与 `count(*)`
 * 都在 SQL 阶段生效，JS 侧丢行会让不可展示的行**占掉名额**——一行正常 + 若干脏行时
 * `?limit=1` 返回空页（用户明明有可展示的未读），角标也会比列表多出几个。
 *
 * 实测（`bun --env-file=../../.env -e`，本仓 drizzle 0.45.2 + bun-sql）：
 * - `jsonb_exists(payload, 'k')` 与 `payload ? 'k'` 在真实列上结果逐行一致；
 *   这里用**函数形式**，避免 `?` 在 SQL 模板/驱动层被当成占位符的歧义；
 * - 键名作为参数时必须显式 `::text`（`jsonb -> text` 与 `jsonb -> integer` 两个重载，
 *   未定型的参数会歧义）；
 * - `isfinite(NULL)` 为 NULL，所以 `read_at` 那条必须写成 `IS NULL OR isfinite(...)`。
 */
const projectable = and(
  inArray(notifications.type, [...notificationTypeSchema.options]),
  sql`jsonb_typeof(${notifications.payload}) = 'object'`,
  sql`isfinite(${notifications.createdAt})`,
  sql`(${notifications.readAt} IS NULL OR isfinite(${notifications.readAt}))`,
  ...Object.keys(notificationPayloadSchema.shape).map(
    (key) =>
      sql`(NOT jsonb_exists(${notifications.payload}, ${key}::text) OR jsonb_typeof(${notifications.payload} -> ${key}::text) = 'string')`,
  ),
)

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
        .where(and(eq(notifications.userId, userId), projectable))
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(limit)
    },

    async countUnread(userId) {
      // 走 `notifications_user_id_unread_idx`（部分索引 `WHERE read_at IS NULL`），
      // 这也是 #23 要求「未读数单独端点」的底气：它不扫列表。
      // 与 listByUser 共用同一个 projectable，所以角标**恒等于**列表能展示的未读条数。
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(notifications)
        .where(and(eq(notifications.userId, userId), isNull(notifications.readAt), projectable))
      return Number(rows[0]?.count ?? 0)
    },

    async markRead(id, userId, readAt) {
      // 同一个 projectable 也在这里：否则会出现「响应说 404、库里 read_at 已被改」——
      // 一条自相矛盾的 404（重试仍然 404，但角标已经掉了一个）。一行 WHERE 就能让 404 零写入。
      const rows = await db
        .update(notifications)
        .set({ readAt: sql`coalesce(${notifications.readAt}, ${readAt})` })
        .where(and(eq(notifications.id, id), eq(notifications.userId, userId), projectable))
        .returning(notificationColumns)
      return rows[0] ?? null
    },
  }
}
