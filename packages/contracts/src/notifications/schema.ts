import { z } from 'zod'
import {
  ListingIdSchema,
  MatchIdSchema,
  NotificationIdSchema,
  WishIdSchema,
} from '../system/public-id'

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
 * - 列表、未读数、标记已读共用一个「行能否投影」的 SQL 谓词（store 的 `projectable`），
 *   `type` 取自本枚举。非规范、非字符串的引用只在出口省略该字段；行无法展示时
 *   （`type` 不在枚举、`payload` 不是对象、通知 ID 非 UUIDv7、时间戳非有限），它既不在列表里
 *   （也不占用 `limit` 名额、不会让 `?limit=1` 返回空页），也不计进 `unreadCount`，
 *   标记已读返回 404 且**不改库** —— 三处口径由 SQL 保证一致。P1 加降价通知只要扩本枚举，
 *   三处自动同步；反过来说，**契约与 worker 必须一起改**，否则新 type 的通知对用户不可见。
 * - 服务端将内部 UUIDv7 转为严格的公开 TypeID，并在投影后作 zod 校验；SQL 判据
 *   与 zod 是两套语言，若将来加字段时未对齐，跳过脏行而不把整页打成 500。
 */

/**
 * `payload` 的形状（jsonb，按 `type` 解释）。`MATCH` 是 `{ matchId, listingId, wishId }`。
 *
 * 三个 ID 都是可选的，公开出口分别为 `mtc_` / `lst_` / `wsh_`。
 * 被删除或无法映射的历史引用只省略该字段，不删除整条通知；数据库 JSON 原文不改。
 */
export const notificationPayloadSchema = z.object({
  // Runtime validates strict TypeIDs. Keep DTO TypeScript fields as string until the
  // miniapp's fixture data can be changed under its separate per-page approval gate.
  matchId: MatchIdSchema.transform((id): string => id).optional(),
  listingId: ListingIdSchema.transform((id): string => id).optional(),
  wishId: WishIdSchema.transform((id): string => id).optional(),
})
export type NotificationPayload = z.infer<typeof notificationPayloadSchema>

/**
 * 通知读模型。**刻意不带 `userId`**：列表与标记已读都只作用于本人，返回收件人 id 没有任何
 * 调用方，只会多一个可被误用的字段。
 */
export const notificationDtoSchema = z.object({
  id: NotificationIdSchema.transform((id): string => id),
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
   * 非法 TypeID（包括裸 UUID）的路径参数同样直接 404，不打到 PG。
   */
  'NOTIFICATION_NOT_FOUND',
])
export type NotificationErrorCode = z.infer<typeof NotificationErrorCodeSchema>
