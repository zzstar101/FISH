import type { Db } from '@fish/db/client'
import { listings } from '@fish/db/schema/listings'
import { users } from '@fish/db/schema/users'
import { listingViewHistory } from '@fish/db/schema/view-history'
import { and, desc, eq, gte, lt, or, type SQL, sql } from 'drizzle-orm'
import type { ListingCardSource } from '../listings/card'
import type { ViewHistoryCursor } from './cursor'

/**
 * 浏览足迹的持久化（#415 M1）。表与两条索引见 `packages/db/src/schema/view-history.ts`。
 *
 * ## 卡片投影复用 `listings/card.ts`
 *
 * 与 `favorites/store.ts` 同一套：只 SELECT `ListingCardSource` 需要的列 + 封面对象键，
 * 映射交给共享的 `toListingCard`。卡片形状、`listingNo` 的 bigint→string、脏行跳过只有一份。
 *
 * ## 窗口与排序
 *
 * - **窗口**：`last_viewed_at >= since`（服务层算好 30 天前的时间点传进来，测试可直接控制）。
 *   列表与 `total` 必须用同一个 `since`，否则数字栏与列表对不上。
 * - **排序**：`(last_viewed_at DESC, listings.id DESC)`。索引第三列是本表 `id`，
 *   所以末列 tie-break（商品 id）是在同 `last_viewed_at` 的分组内现排的 —— 分组通常极小，
 *   代价可忽略；顺序是全序（`(user_id, listing_id)` 唯一），游标因此不重不漏。
 */

/** 列表的一行：卡片源 + 封面键 + 两个时间戳（对外毫秒一个、构造游标微秒一个）。 */
export interface ViewHistoryRow extends ListingCardSource {
  coverObjectKey: string | null
  /** 毫秒精度 ISO 文本，直接进契约的 `z.iso.datetime()`（不经过 `Date`，避免精度与时区干扰）。 */
  viewedAt: string
  /** 微秒精度的 `last_viewed_at` UTC ISO 文本，仅供构造游标。 */
  viewedAtCursor: string
}

export interface ViewHistoryStore {
  /** 窗口内的足迹，多取一行由调用方判断还有没有下一页。 */
  listViewHistory(
    userId: string,
    limit: number,
    cursor: ViewHistoryCursor | null,
    since: Date,
  ): Promise<ViewHistoryRow[]>
  /** 窗口内的全量计数，与 `listViewHistory` 同一张表、同一个 `since`。 */
  totalViewHistory(userId: string, since: Date): Promise<number>
  /** 清空本人足迹，返回删除行数（幂等：没有行就是 0）。 */
  clearViewHistory(userId: string): Promise<number>
}

/** `(last_viewed_at, 商品 id) < (cursor)`，与 `last_viewed_at DESC, listings.id DESC` 同向。 */
function cursorCondition(cursor: ViewHistoryCursor): SQL {
  return or(
    sql`${listingViewHistory.lastViewedAt} < ${cursor.viewedAt}::timestamptz`,
    and(
      sql`${listingViewHistory.lastViewedAt} = ${cursor.viewedAt}::timestamptz`,
      lt(listings.id, cursor.listingId),
    ),
  ) as SQL
}

export function createSqlViewHistoryStore(db: Db): ViewHistoryStore {
  return {
    async listViewHistory(userId, limit, cursor, since) {
      const conditions: SQL[] = [
        eq(listingViewHistory.userId, userId),
        gte(listingViewHistory.lastViewedAt, since),
      ]
      if (cursor) conditions.push(cursorCondition(cursor))

      return (
        db
          .select({
            id: listings.id,
            listingNo: listings.listingNo,
            title: listings.title,
            priceCents: listings.priceCents,
            category: listings.category,
            condition: listings.condition,
            status: listings.status,
            urgent: listings.urgent,
            negotiable: listings.negotiable,
            free: listings.free,
            createdAt: listings.createdAt,
            // 卖家公开子集（#191）：与 feed / 收藏 / 他人主页同一 inner join 同源投影，
            // 卡片要能直接渲染卖家（昵称 / 头像 / 认证态），不逐卡补查。
            seller: {
              id: users.id,
              nickname: users.nickname,
              avatarUrl: users.avatarUrl,
              authStatus: users.authStatus,
            },
            // 封面只认 `sort_order = 0`（#6 契约 §1：下标即 sortOrder，0 才是封面）。
            coverObjectKey: sql<
              string | null
            >`(SELECT li.object_key FROM listing_images li WHERE li.listing_id = ${listings.id} AND li.sort_order = 0 LIMIT 1)`,
            // 毫秒给契约、微秒给游标：`last_viewed_at` 是 timestamptz（微秒），游标必须保留微秒
            // 才不重不漏；对外那个字段只需要毫秒（`z.iso.datetime()` 的形状）。
            viewedAt: sql<string>`to_char(${listingViewHistory.lastViewedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
            viewedAtCursor: sql<string>`to_char(${listingViewHistory.lastViewedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          })
          .from(listingViewHistory)
          .innerJoin(listings, eq(listings.id, listingViewHistory.listingId))
          .innerJoin(users, eq(users.id, listings.sellerId))
          .where(and(...conditions))
          .orderBy(desc(listingViewHistory.lastViewedAt), desc(listings.id))
          // 多取一行用于判断"还有没有下一页"，返回前丢掉（与 listings feed / 收藏同款）。
          .limit(limit + 1)
      )
    },

    async totalViewHistory(userId, since) {
      const rows = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(listingViewHistory)
        .where(
          and(eq(listingViewHistory.userId, userId), gte(listingViewHistory.lastViewedAt, since)),
        )
      return Number(rows[0]?.total ?? 0)
    },

    async clearViewHistory(userId) {
      // 无条件删本表本人行：没有行也是成功（幂等）。**只删足迹表**，
      // 训练用的 `recommendation_events` 一行不动（Owner 待定项 1 的推荐默认）。
      const deleted = await db
        .delete(listingViewHistory)
        .where(eq(listingViewHistory.userId, userId))
        .returning({ id: listingViewHistory.id })
      return deleted.length
    },
  }
}
