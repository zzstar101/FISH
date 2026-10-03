import { z } from 'zod'
import { ListingCardSchema } from '../listings/schema'

/**
 * View History Domain Contract（Issue #415 M1 —— 浏览记录）。
 *
 * 表由本 Issue 落地（`packages/db/src/schema/view-history.ts`）：`(user_id, listing_id)` 唯一，
 * 同一件商品只留一行、时间取最近一次浏览；`(user_id, last_viewed_at, id)` 是列表的稳定游标顺序。
 *
 * ## 为什么是独立域，而不是读 `recommendation_events`
 *
 * 行为事件表是训练资产（只追加、保留 180 天），浏览记录是用户资产（端上承诺 30 天 + 可清空）。
 * 用户行使删除权不该破坏训练数据的 append-only 语义，所以本域有自己的表与读写端点；
 * 写入由 `DETAIL_VIEW` 事件触发（服务端在 ingest 事务内顺带 upsert），端上零新增调用。
 *
 * ## 保留期与「全部浏览」的文案冲突（Owner 待定，见 Issue #415 开放问题 3）
 *
 * 端上第一档叫「全部浏览」，而保留期文案写「只保留最近 30 天」。本契约把 30 天定义为
 * **读窗口**（`VIEW_HISTORY_RETENTION_DAYS`，读接口过滤 + `total` 同窗口），
 * 与「数据是否更久保留」无关（物理清理也在 30 天）。若 Owner 改选「全量历史」，
 * 只需去掉窗口过滤、契约形状不变。
 *
 * ## 失效商品保留展示
 *
 * 与收藏同一口径：商品下架（`OFFLINE`）或售出（`SOLD`）后足迹仍在列表里，客户端读
 * `listing.status` 自己决定怎么展示，**不新增「是否失效」字段**。只有商品被**物理删除**
 * 时行才消失（外键 CASCADE，见 schema 注释）。
 */

/**
 * 浏览记录的**读窗口**：30 天（端上文案已冻结，`apps/miniapp/src/pages/history/records.ts:292`）。
 *
 * 定义在契约里而不是各端各写一份：读接口的过滤、`total` 的计数窗口、worker 的物理清理
 * 必须用同一个数字，分散必然漂移。
 */
export const VIEW_HISTORY_RETENTION_DAYS = 30

/** 读窗口的毫秒数（端上与服务端共用；`VIEW_HISTORY_RETENTION_DAYS * 24h`）。 */
export const VIEW_HISTORY_RETENTION_MS = VIEW_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1_000

/** 浏览记录的一行：公开商品卡片 + 我最近一次看它的时间。 */
export const ViewHistoryItemSchema = z.object({
  listing: ListingCardSchema,
  /** 最近一次浏览时刻（`listing_view_history.last_viewed_at`）；列表按它倒序，端上按它分日。 */
  viewedAt: z.iso.datetime(),
})

export type ViewHistoryItem = z.infer<typeof ViewHistoryItemSchema>

/**
 * `GET /me/view-history` 的查询参数。
 *
 * 只接受 `limit` / `cursor`：用户 id 由登录态决定，端上无法指定别人的浏览记录，
 * 所以是 `strictObject` 而不是「多传就忽略」—— 多传未知参数报 422，把越权尝试暴露出来。
 * `limit` 边界与公开 Feed / 收藏逐字相同：默认 20、上限 50。
 */
export const MyViewHistoryQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /** 不透明字符串：服务端对 `(last_viewed_at, 商品 id)` 编码，前端禁止解析或构造，只原样回传。 */
  cursor: z.string().min(1).optional(),
})

export type MyViewHistoryQuery = z.infer<typeof MyViewHistoryQuerySchema>

/**
 * 浏览记录列表响应。
 *
 * `total` 是**全量**计数（服务端 COUNT，与列表同一张表、同一个 30 天窗口），不是这一页的长度：
 * 分页列表拿不出全量计数，旁路再发一个 count 请求又会让两个数字有机会不一致。
 * `nextCursor !== null` 即还有下一页（与 feed 同语义）。
 */
export const MyViewHistoryResponseSchema = z.object({
  items: z.array(ViewHistoryItemSchema),
  nextCursor: z.string().nullable(),
  /** 窗口内的总条数（全量，不是这一页）。 */
  total: z.number().int().nonnegative(),
})

export type MyViewHistoryResponse = z.infer<typeof MyViewHistoryResponseSchema>

/**
 * `DELETE /me/view-history` 的响应：清掉了多少行。
 *
 * 幂等：没有记录时 `deleted: 0` 也是成功（与 comments 的删除同一取舍 —— 端上重复点击
 * 「清空」不该报错）。回行数而不是 204，是为了让端上能区分「本来就没有」与「清掉了 N 条」。
 */
export const ClearViewHistoryResponseSchema = z.object({
  deleted: z.number().int().nonnegative(),
})

export type ClearViewHistoryResponse = z.infer<typeof ClearViewHistoryResponseSchema>
