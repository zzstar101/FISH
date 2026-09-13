import {
  type NotificationDto,
  type NotificationListQuery,
  type NotificationListResponse,
  type NotificationUnreadCount,
  notificationDtoSchema,
} from '@fish/contracts/notifications/schema'
import type { NotificationRow, NotificationStore } from './store'

export class NotificationServiceError extends Error {
  constructor(
    /** HTTP 状态码；code 取值域由契约的 `NotificationErrorCodeSchema` 收窄。 */
    readonly status: 404,
    readonly code: 'NOTIFICATION_NOT_FOUND',
    message: string,
  ) {
    super(message)
    this.name = 'NotificationServiceError'
  }
}

/** 不存在与「不是我的」用**同一个**响应：契约决定 2，不泄漏存在性。 */
const notFound = () => new NotificationServiceError(404, 'NOTIFICATION_NOT_FOUND', '通知不存在')

/**
 * 库里的时间戳 → 契约的 ISO 字符串。`null` 原样返回（`read_at` 的「未读」）；
 * **返回 `undefined` 表示这一行没法投影**，调用方据此跳过整行。
 *
 * 为什么要这一层：PG 的 `timestamptz` 能存 `'infinity'`/`'294276-01-01'`，而 JS 的 `Date`
 * 表示不了它们——`new Date(Infinity).toISOString()` 直接抛 `RangeError`（实测：bun-sql 把
 * `'infinity'` 的 `read_at` 解成 `Infinity`，typed builder 则给 `undefined`）。
 * 少了这道判断，一行越权写入的脏数据会把整个 `GET /notifications` 打成 500，
 * 正是「单行脏数据不让整页打不开」要避免的结果。
 */
function toIsoTimestamp(value: Date | null): string | null | undefined {
  if (value === null) return null
  if (!(value instanceof Date)) return undefined // 驱动对 'infinity' 会给出非 Date 值
  const ms = value.getTime()
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

function toNotificationDto(row: NotificationRow): NotificationDto | null {
  const readAt = toIsoTimestamp(row.read_at)
  const createdAt = toIsoTimestamp(row.created_at)
  if (readAt === undefined || createdAt === undefined) return null

  const parsed = notificationDtoSchema.safeParse({
    id: row.id,
    type: row.type,
    payload: row.payload,
    readAt,
    createdAt,
  })
  return parsed.success ? parsed.data : null
}

export interface NotificationService {
  listNotifications(userId: string, query: NotificationListQuery): Promise<NotificationListResponse>
  getUnreadCount(userId: string): Promise<NotificationUnreadCount>
  /** 幂等：已读再点仍是 200，且返回体的 `readAt` 保持**首次**已读时间不变。 */
  markRead(userId: string, id: string): Promise<NotificationDto>
}

export function createNotificationService({
  store,
}: {
  store: NotificationStore
}): NotificationService {
  return {
    async listNotifications(userId, query) {
      const rows = await store.listByUser(userId, query.limit)
      return {
        // 列表里的行一定已经通过 SQL 的 type 谓词（store 的 projectableType），角标用的是**同一个**
        // 谓词，所以「列表能展示的未读条数」与 unreadCount 恒相等，脏 type 的行也不会占掉 LIMIT 名额。
        // 这里再投影一次是最后一道闸门：payload 形状 / 时间戳这两类脏值只可能在 JS 侧判掉
        // （SQL 表达不了契约的 jsonb 校验），记日志跳过，不让整个列表打不开——与 #12 profile 的
        // 决策 C 同一取舍。这类值经本仓写入路径不可达（worker 只写 `type: 'MATCH'` + 合法 payload，
        // 时间戳只有 now() 与本模块的 Date）；将来若出现**可达**的脏值维度，按 type 的先例
        // 在 SQL 层加谓词，而不是继续在 JS 里丢行（那会重新引入「脏行吃 LIMIT」）。
        items: rows.flatMap((row) => {
          const dto = toNotificationDto(row)
          if (!dto) {
            console.error('[notifications] 跳过无法映射为契约的通知', row.id)
            return []
          }
          return [dto]
        }),
      }
    },

    async getUnreadCount(userId) {
      return { unreadCount: await store.countUnread(userId) }
    },

    async markRead(userId, id) {
      // `user_id` 已写进 UPDATE 的 WHERE（store），所以「不是我的」与「不存在」在这里
      // 是同一个 null：一律 404，不区分（契约决定 2）。
      const row = await store.markRead(id, userId, new Date())
      if (!row) throw notFound()

      const dto = toNotificationDto(row)
      if (!dto) {
        // type 不在契约里的行已经被 store 的谓词挡在 UPDATE 之外（404 且**零写入**）。
        // 走到这里只剩 payload 形状 / 时间戳两类脏值：`row` 存在、UPDATE 已执行，记日志并 404
        // （不 500）。这两类值经写入路径不可达，故不为它再加一层「先校验再写」。
        console.error('[notifications] 标记已读后无法映射为契约的通知', row.id)
        throw notFound()
      }
      return dto
    },
  }
}
