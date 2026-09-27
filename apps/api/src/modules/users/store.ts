import type { ListingCard } from '@fish/contracts/listings/schema'
import type { PublicUserProfile } from '@fish/contracts/users/schema'
import type { Db } from '@fish/db/client'
import { listingImages, listings } from '@fish/db/schema/listings'
import { users } from '@fish/db/schema/users'
import { and, desc, eq, inArray, lt, or, type SQL, sql } from 'drizzle-orm'

/**
 * 公开用户读模型的持久化（Issue #122）。
 *
 * ## 隐私边界落在**列投影**上，不落在 DTO 上
 *
 * `findPublicUser` 只 SELECT 公开列：`id / nickname / avatar_url / auth_status / created_at`。
 * `student_no` / `campus` / `campus_email` / `password_hash` / `role` **不出现在任何 SELECT 里**
 * ——契约层就算被人改成 `.passthrough()`，这些列也不会从库里被读出来。这是本域最重要的一行约束：
 * 「不泄漏」靠的是**没查**，不是"查了再删"。
 *
 * ## 与 `profile` 域的分工
 *
 * 本域只读已合并的 `users` / `listings` / `transactions` 表（与 `profile/store.ts` 同一取舍：
 * 读模型不调用其他 Domain API、不承担写操作），商品卡的投影复用 `listings/card.ts` 的
 * `toListingCard`（`matching` / `profile` 也复用同一份），封面口径 `sort_order = 0` 与
 * feed / 详情一致。
 */

/** 公开用户行：**只有**这五列，其余列连查都不查。 */
export interface PublicUserRow {
  id: string
  nickname: string
  avatarUrl: string | null
  authStatus: PublicUserProfile['authStatus']
  /** 加入时间（服务端据此算 `joinedDays`，不把时间戳本身发给客户端）。 */
  createdAt: Date
}

export interface PublicUserStatsRow {
  /** 在售数：口径必须与 `listActiveListings` 完全一致，否则页面会出现"写着 5 件、只列出 3 件"。 */
  activeListings: number
  /** 卖出数：已完成交易里 TA 是卖家的条数。 */
  soldCount: number
}

/** 一行在售商品：字段恰好够 `toListingCard` 用（`ListingCardSource` 的结构类型）。 */
export interface PublicListingRow {
  id: string
  listingNo: bigint
  title: string
  priceCents: number
  category: ListingCard['category']
  condition: ListingCard['condition']
  status: ListingCard['status']
  urgent: boolean
  negotiable: boolean
  free: boolean
  createdAt: Date
  /** 微秒精度的 `created_at` 文本，仅用于构造游标（JS `Date` 只有毫秒，翻页会漏行）。 */
  createdAtCursor: string
  coverObjectKey: string | null
}

/** 游标在 store 层是**已解码**结构；合法性由 service 校验后才走到这里。 */
export type PublicListingCursor = { createdAt: string; id: string }

export interface PublicUserStore {
  /** 按 id 取公开资料列；不存在返回 null（**不区分**"不存在"与"不可见"）。 */
  findPublicUser(userId: string): Promise<PublicUserRow | null>
  stats(userId: string): Promise<PublicUserStatsRow>
  /** 取 TA 的在售商品，`created_at DESC, id DESC`，多取一行由调用方判断还有没有下一页。 */
  listActiveListings(
    userId: string,
    limit: number,
    cursor: PublicListingCursor | null,
  ): Promise<PublicListingRow[]>
}

/**
 * 裸 SQL 的返回形状在不同驱动下是数组或 `{ rows }`；本域只有统计那一处用裸 SQL，
 * 因此只取第一行的归一（与 `profile/store.ts` 的 `rowsOf` 同一取舍，这里不需要数组）。
 */
function firstRowOf(result: unknown): Record<string, unknown> | null {
  if (Array.isArray(result)) return (result[0] as Record<string, unknown>) ?? null
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (
      ((result as { rows: Record<string, unknown>[] }).rows[0] as Record<string, unknown>) ?? null
    )
  }
  return null
}

/**
 * 游标条件：`(created_at, id) < (cursor.createdAt, cursor.id)`，与 `created_at DESC, id DESC` 同向。
 * 文本 + `::timestamptz` 保留微秒（与 `comments/store.ts` 同一写法）。
 */
function cursorCondition(cursor: PublicListingCursor): SQL {
  return or(
    sql`${listings.createdAt} < ${cursor.createdAt}::timestamptz`,
    and(sql`${listings.createdAt} = ${cursor.createdAt}::timestamptz`, lt(listings.id, cursor.id)),
  ) as SQL
}

export function createSqlPublicUserStore(db: Db): PublicUserStore {
  return {
    async findPublicUser(userId) {
      const rows = await db
        .select({
          id: users.id,
          nickname: users.nickname,
          avatarUrl: users.avatarUrl,
          authStatus: users.authStatus,
          createdAt: users.createdAt,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
      return rows[0] ?? null
    },

    async stats(userId) {
      // 两个计数合成一次往返。**在售数的过滤条件必须与 listActiveListings 逐字相同**
      // （ACTIVE + APPROVED），否则页面顶部写「在售 5 件」而下面只列出 3 件。
      // `moderation_status = 'APPROVED'` 是公开可见性的第二道闸（与 listings feed 的
      // `includeUnapproved: false` 同口径）：只判 status 会把审核未通过的 ACTIVE 商品算进去。
      const result = await db.execute(sql`
        SELECT
          (SELECT count(*)::int FROM listings
            WHERE seller_id = ${userId} AND status = 'ACTIVE'
              AND moderation_status = 'APPROVED') AS active_listings,
          (SELECT count(*)::int FROM transactions
            WHERE seller_id = ${userId} AND status = 'COMPLETED') AS sold_count
      `)
      const row = firstRowOf(result)
      if (!row) throw new Error('公开用户统计查询未返回行')
      return {
        activeListings: Number(row.active_listings),
        soldCount: Number(row.sold_count),
      }
    },

    async listActiveListings(userId, limit, cursor) {
      const conditions: SQL[] = [
        eq(listings.sellerId, userId),
        // 公开在售列表：只出 ACTIVE。已售 / 已下架 / 已预定一律不在其中（#122 验收）。
        eq(listings.status, 'ACTIVE'),
        eq(listings.moderationStatus, 'APPROVED'),
      ]
      if (cursor) conditions.push(cursorCondition(cursor))

      const rows = await db
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
          createdAtCursor: sql<string>`to_char(${listings.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(listings)
        .where(and(...conditions))
        .orderBy(desc(listings.createdAt), desc(listings.id))
        // 多取一行用于判断"还有没有下一页"，返回前丢掉（与 listings feed 同款）。
        .limit(limit + 1)

      if (rows.length === 0) return []

      // 封面单独查一次，**不能内联成相关子查询**：裸 `sql` 片段里的 `${listings.id}` 会被渲染成
      // 不带表名的 `"id"`（实测生成 `WHERE li.listing_id = "id"`），在子查询作用域里会静默解析成
      // `listing_images.id` —— 结果恒为 null，而 SQL 本身完全合法、连报错都没有。
      // 写法与 listings feed 一致：一页最多 50 条，一次 inArray 查回来。
      const coverRows = await db
        .select({ listingId: listingImages.listingId, objectKey: listingImages.objectKey })
        .from(listingImages)
        .where(
          and(
            inArray(
              listingImages.listingId,
              rows.map((row) => row.id),
            ),
            // 封面口径：只有 `sort_order = 0` 才是封面（#6 契约 §1）；取不到 0 号图就是没有封面，
            // 不能用序号更大的图片顶替。
            eq(listingImages.sortOrder, 0),
          ),
        )

      const coverByListing = new Map(coverRows.map((row) => [row.listingId, row.objectKey]))

      return rows.map((row) => ({ ...row, coverObjectKey: coverByListing.get(row.id) ?? null }))
    },
  }
}
