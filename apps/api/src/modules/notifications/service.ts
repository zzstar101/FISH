import {
  type NotificationDto,
  type NotificationListQuery,
  type NotificationListResponse,
  type NotificationPayload,
  type NotificationUnreadCount,
  notificationDtoSchema,
} from '@fish/contracts/notifications/schema'
import { encodePublicId, PUBLIC_ID_PREFIX, type PublicIdPrefix } from '@fish/shared/public-id'
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

function publicPayloadField<P extends PublicIdPrefix>(prefix: P, raw: unknown) {
  if (typeof raw !== 'string') return undefined
  try {
    return encodePublicId(prefix, raw)
  } catch {
    // An unknown or deleted legacy reference cannot be mapped; keep the notification.
    return undefined
  }
}

function projectPayload(raw: unknown): NotificationPayload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  // Each unrecognizable field is omitted independently; the notification stays visible.
  const matchId = publicPayloadField(PUBLIC_ID_PREFIX.match, value.matchId)
  const listingId = publicPayloadField(PUBLIC_ID_PREFIX.listing, value.listingId)
  const wishId = publicPayloadField(PUBLIC_ID_PREFIX.wish, value.wishId)
  return {
    ...(matchId ? { matchId } : {}),
    ...(listingId ? { listingId } : {}),
    ...(wishId ? { wishId } : {}),
  }
}

function toNotificationDto(row: NotificationRow): NotificationDto | null {
  const readAt = toIsoTimestamp(row.read_at)
  const createdAt = toIsoTimestamp(row.created_at)
  const payload = projectPayload(row.payload)
  if (readAt === undefined || createdAt === undefined || payload === null) return null

  let id: string
  try {
    id = encodePublicId(PUBLIC_ID_PREFIX.notification, row.id)
  } catch {
    return null
  }
  const parsed = notificationDtoSchema.safeParse({ id, type: row.type, payload, readAt, createdAt })
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
        // store 的 projectable 谓词（SQL 层）已经把契约表示不了的行全部挡在 SELECT 之外，
        // 角标用的是**同一个**谓词，所以「列表能展示的未读条数」与 unreadCount 恒相等，
        // 脏行也不会占掉 LIMIT 名额。这里的投影校验保留为**纵深防御**：谓词与契约由两套语言
        // 描述（SQL 判据 vs zod），万一将来加字段时两边没对齐，这里记日志跳过而不是把整页打成 500
        // （与 #12 profile 的决策 C 同一取舍）。
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
        // 契约表示不了的行已经被 store 的 projectable 谓词挡在 UPDATE 之外：404 且**零写入**。
        // 走到这里只可能是「SQL 谓词与 zod 契约、两套语言描述同一件事时没对齐」——保留为
        // 纵深防御：记日志并 404，不 500。
        console.error('[notifications] 标记已读后无法映射为契约的通知', row.id)
        throw notFound()
      }
      return dto
    },
  }
}
