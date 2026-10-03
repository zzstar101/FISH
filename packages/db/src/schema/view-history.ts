import { index, pgTable, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { primaryKey, timestamptz } from './common'
import { listings } from './listings'
import { users } from './users'

/**
 * 浏览足迹（#415 M1）：用户可见的「我看过什么」，与行为事件表**分开存**。
 *
 * ## 为什么不直接读 `recommendation_events`
 *
 * 那张表是训练/分析资产：只追加、不更新不删除（`recommendation-events.ts` 文件头），
 * 保留 180 天，物理删除归 R6 的保留期任务。而「浏览记录」是**用户资产**：端上文案
 * 承诺保留 30 天，并提供「清空」这个删除入口。两者混在一起，「清空」要么删掉训练数据
 * （破坏 append-only 与 R6 保留期），要么只做隐藏水位线（说清空其实没删，对用户不诚实）。
 * 所以本表只承载用户可见的那一份，写入由 `DETAIL_VIEW` 事件触发（同一事务，见
 * `apps/api/src/modules/view-history/ingest.ts`），清空只删本表。
 *
 * ## 唯一键 = 列表去重口径
 *
 * `unique(user_id, listing_id)`：同一件商品只有一行，`last_viewed_at` 取**最近一次**浏览
 * （upsert 用 `GREATEST`，离线队列补发的旧事件不会把时间倒退）。列表因此天然不重复。
 *
 * `(user_id, last_viewed_at, id)` 是列表的稳定游标顺序：`last_viewed_at` 可能同值，
 * 末列 `id` 保证翻页不重不漏。
 *
 * ## 外键的删除行为
 *
 * 两条都 CASCADE：用户被删 → 足迹跟着消失；商品被删 → 该商品的足迹一并消失
 * （与 `recommendation_events` 同一取向——足迹是派生数据，不是 `favorites` 那种
 * 用户主动建立的关系；favorites 的 NO ACTION 是 Owner 2026-09-28 对"收藏怎么办"的单独
 * 拍板，见 `favorites.ts`，不适用于本表）。
 * 商品下架走 `listings.status = 'OFFLINE'`，不触发删除——失效商品**保留在足迹里**，
 * 端上按 `status` 渲染「已下架 / 已卖掉」角标。
 */
export const listingViewHistory = pgTable(
  'listing_view_history',
  {
    ...primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    /** 最近一次浏览时刻（取事件的 `occurred_at`，保留微秒精度给游标）。 */
    lastViewedAt: timestamptz('last_viewed_at').notNull(),
  },
  (table) => [
    uniqueIndex('listing_view_history_user_id_listing_id_uq').on(table.userId, table.listingId),
    index('listing_view_history_user_id_last_viewed_at_id_idx').on(
      table.userId,
      table.lastViewedAt,
      table.id,
    ),
  ],
)
