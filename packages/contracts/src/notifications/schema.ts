import { z } from 'zod'

/**
 * Notification Domain Contract（Issue #23）。前端与 API 只依赖本目录的字段定义。
 *
 * 表结构由 #2 冻结（`packages/db/src/schema/notifications.ts`），本域**不新增任何表/列**：
 * 收件人 `user_id`、`type`（text + TS 收窄）、`payload`（jsonb）、`read_at`（NULL = 未读）、
 * `created_at` 五列就够，未读数走既有的 `(user_id) WHERE read_at IS NULL` 部分索引。
 *
 * 两条写进契约的决定：
 *
 * 1. **服务端不存也不返回文案**：库里只有 `type` + `payload`，标题/描述/图标由客户端按
 *    `type`（必要时结合 `payload` 回查商品名）渲染，因此 DTO 里没有任何文案字段——
 *    改文案不用动数据、不用迁移。
 * 2. **他人的通知一律 404**（`NOTIFICATION_NOT_FOUND`），不区分「不存在」与「不是我的」：
 *    与 #6 / #8 / #9 的「不泄漏存在性」同一口径，403 等于告诉攻击者「这个 id 真实存在」。
 */

/**
 * 通知类型。P0 只有 `MATCH`（#8 的匹配引擎在「愿望 ↔ 商品」首次命中时写入，收件人是愿望所有者）。
 *
 * 与库里的 `text + TS 收窄` 保持一致而**不用 pgEnum**：值集尚未冻结（P1 还有降价通知），
 * 加类型时改这一处 + `packages/db/src/schema/notifications.ts` 的类型，不必迁移枚举。
 */
export const notificationTypeSchema = z.enum(['MATCH'])
export type NotificationType = z.infer<typeof notificationTypeSchema>

/**
 * 读侧口径（冻结，与 `apps/api/src/modules/notifications/{store,service}.ts` 的注释一致）：
 *
 * - 列表、未读数、标记已读**共用同一个「契约能表示这一行」的 SQL 谓词**（store 的 `projectable`），
 *   判据的值域全部从本域契约派生：`type` 取自本枚举，`payload` 的键名取自
 *   `notificationPayloadSchema`（SQL 里没有第二份 type/键名列表）。库里出现契约表示不了的行时
 *   （`type` 不在枚举、`payload` 不是对象、键值不是字符串、时间戳非有限），它既不在列表里
 *   （也不占用 `limit` 名额、不会让 `?limit=1` 返回空页），也不计进 `unreadCount`，
 *   标记已读返回 404 且**不改库** —— 三处口径由 SQL 保证一致。P1 加降价通知只要扩本枚举，
 *   三处自动同步；反过来说，**契约与 worker 必须一起改**，否则新 type 的通知对用户不可见。
 * - 服务端另有一层 zod 投影校验，语义与上面一致，作为纵深防御：SQL 判据与 zod 契约是两套语言
 *   描述同一件事，万一将来加字段时两边没对齐，记日志跳过而不是把整页打成 500。
 */

/**
 * `payload` 的形状（jsonb，按 `type` 解释）。`MATCH` 是 `{ matchId, listingId, wishId }`。
 *
 * 三个 id 都是可选的，而且用 `z.string()` 不用 `z.uuid()`：
 * - 可选是因为它们指向的对象**可能已被删除**（沿用 #6 的口径：跳转前各自确认，确认不了就退回列表）；
 * - 不校验 uuid 是因为 payload 是 jsonb 自由形状，历史/越权写入的脏值不该让整个列表打不开
 *   （与 listings 侧对 `users.avatar_url` 的取舍同源）。
 */
export const notificationPayloadSchema = z.object({
  matchId: z.string().optional(),
  listingId: z.string().optional(),
  wishId: z.string().optional(),
})
export type NotificationPayload = z.infer<typeof notificationPayloadSchema>

/**
 * 通知读模型。**刻意不带 `userId`**：列表与标记已读都只作用于本人，返回收件人 id 没有任何
 * 调用方，只会多一个可被误用的字段。
 */
export const notificationDtoSchema = z.object({
  id: z.string(),
  type: notificationTypeSchema,
  payload: notificationPayloadSchema,
  /** 已读时间；`null` = 未读（与库里 `read_at IS NULL` 完全同口径，不额外造布尔字段）。 */
  readAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
})
export type NotificationDto = z.infer<typeof notificationDtoSchema>

/**
 * 列表查询。`limit` 默认 20、上限 50；越界（`0` / `51` / 非数字）→ 422 `VALIDATION_FAILED`。
 *
 * 没有 cursor 也没有 `total`：P0 的通知量级是个位数到几十，超出上限的翻页属于 demo 数据量
 * 之外的规模，届时应扩游标端点而不是在这里加 `offset`（与 #8 的 `MatchListQuerySchema` 同一取舍）。
 */
export const notificationListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
})
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>

export const notificationListResponseSchema = z.object({ items: z.array(notificationDtoSchema) })
export type NotificationListResponse = z.infer<typeof notificationListResponseSchema>

/**
 * 未读数。**独立端点**而不是塞进列表响应：底部导航/置顶行的角标只为一个数字，
 * 不该为了它拉一整页通知（列表页的「N 条未读」由它自己那份 items 数出来）。
 */
export const notificationUnreadCountSchema = z.object({
  unreadCount: z.number().int().nonnegative(),
})
export type NotificationUnreadCount = z.infer<typeof notificationUnreadCountSchema>

/**
 * 本 domain 新增的错误码。其余复用 system 的 `VALIDATION_FAILED`（422）与 auth 的
 * `UNAUTHENTICATED`（401）。
 */
export const NotificationErrorCodeSchema = z.enum([
  /**
   * 404：通知不存在，**或**存在但不是当前用户的（决定 2：不泄漏存在性）。
   * 非法 uuid 的路径参数同样直接 404，不打到 PG 变成 500。
   */
  'NOTIFICATION_NOT_FOUND',
])
export type NotificationErrorCode = z.infer<typeof NotificationErrorCodeSchema>
