import type { ListingCard } from '@fish/contracts/listings/schema'
import type { PublicUserProfile } from '@fish/contracts/users/schema'
import type { Db } from '@fish/db/client'
import { listingViewsCount } from '@fish/db/listing-views'
import { listingWantsCount } from '@fish/db/listing-wants'
import { listingImages, listings } from '@fish/db/schema/listings'
import { users } from '@fish/db/schema/users'
import { and, desc, eq, inArray, isNull, lt, ne, or, type SQL, sql } from 'drizzle-orm'
import type { ListingCardSeller } from '../listings/card'

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

/** 公开用户行：**只有**这几列，其余列连查都不查。 */
export interface PublicUserRow {
  id: string
  nickname: string
  avatarUrl: string | null
  authStatus: PublicUserProfile['authStatus']
  /** 个性签名（#179）：用户自填的自我介绍，`null` = 未填写或已清空。 */
  signature: string | null
  /** 加入时间（服务端据此算 `joinedDays`，不把时间戳本身发给客户端）。 */
  createdAt: Date
}

export interface PublicUserStatsRow {
  /** 在售数：口径必须与 `listListings(…, 'ACTIVE', …)` 完全一致，否则页面会出现"写着 5 件、只列出 3 件"。 */
  activeListings: number
  /**
   * 已售出数：口径必须与 `listListings(…, 'SOLD', …)` 完全一致 —— 按 `listings` 表的
   * `status = 'SOLD'` 且 `governance_delisted_at IS NULL` 计数（#565 复核订正：原先是
   * `transactions` 里已完成交易的条数，与列表不同源，段头与列表会自相矛盾）。
   */
  soldCount: number
}

/** 一行在售 / 已售出商品：字段恰好够 `toListingCard` 用（`ListingCardSource` 的结构类型）。 */
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
  /** 卖家公开投影源列（#191）：inner join users 同源带出（在售列表的卖家即本主页用户）。 */
  seller: ListingCardSeller
  /** 想要数（= 已建会话的买家数，见 `@fish/db/listing-wants`）：卡片契约的必填字段。 */
  wants: number
  /** 浏览量（近 30 天去重浏览人数，见 `@fish/db/listing-views`）：与「想要数」并排画，同样必填。 */
  views: number
}

/** 游标在 store 层是**已解码**结构；合法性由 service 校验后才走到这里。 */
export type PublicListingCursor = { createdAt: string; id: string }

/**
 * 公开读模型允许的两种口径（#565）：`ACTIVE` = 在售、`SOLD` = 已售出。
 *
 * 与契约 `PublicUserListingsQuerySchema.status` 的值域**逐字相同**：契约已把
 * OFFLINE / RESERVED 拒在 422，所以这里的类型就是这一层的完整值域，不需要再兜一层。
 */
export type PublicUserListingStatus = 'ACTIVE' | 'SOLD'

export interface PublicUserStore {
  /** 按 id 取公开资料列；不存在或**已注销**（#464）返回 null（不区分"不存在"与"不可见"）。 */
  findPublicUser(userId: string): Promise<PublicUserRow | null>
  stats(userId: string): Promise<PublicUserStatsRow>
  /**
   * 取 TA 的某一类商品（在售 / 已售出），`created_at DESC, id DESC`，
   * 多取一行由调用方判断还有没有下一页。
   */
  listListings(
    userId: string,
    status: PublicUserListingStatus,
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
          signature: users.signature,
          createdAt: users.createdAt,
        })
        .from(users)
        // 已注销账号（#464）在**公开读模型**里与"不存在"同义：`/users/:id/public` 与
        // `/users/:id/listings` 都返回 404，不给匿名访客留一个「已注销用户」的空主页。
        // 私域历史引用（商品卡、聊天、订单）不走这里，仍按 `nickname` 占位显示「已注销用户」。
        .where(and(eq(users.id, userId), ne(users.accountStatus, 'DELETED')))
        .limit(1)
      return rows[0] ?? null
    },

    async stats(userId) {
      // 两个计数合成一次往返。**两段计数的过滤条件必须与 listListings 对应分支逐字相同**
      // （在售 = ACTIVE + APPROVED；已售出 = SOLD + 未治理下架），否则页头写「在售 5 件」
      // 而下面只列出 3 件、或者「已售出 3 件」点进去只有 1 件。
      // `moderation_status = 'APPROVED'` 是公开可见性的第二道闸（与 listings feed 的
      // `includeUnapproved: false` 同口径）：只判 status 会把审核未通过的 ACTIVE 商品算进去。
      //
      // 已售出数（#565 复核订正）：口径是**可见的已售商品数**（listings 表），不再是
      // 「成交笔数」（transactions 表）。原实现走 `transactions(status = 'COMPLETED')`，
      // 与列表的 `listings.status = 'SOLD'` 是两个数据源，两边条数会打架：
      //   · 治理下架（`governance_delisted_at != null`）商品成交时，`confirm` 路径把
      //     `status` 保成 OFFLINE、核销路径才会无条件置 SOLD —— 同一笔成交在两个源里
      //     一侧算、另一侧不算；
      //   · 列表按 #565 的公开可见性口径要筛掉「平台已下架」的商品，计数不跟着筛就等于
      //     把被筛掉的那几件还写在段头。
      // 所以计数改成与 `listListings(…, 'SOLD', …)` 同源同条件：`status = 'SOLD'`
      // 且 `governance_delisted_at IS NULL`。
      const result = await db.execute(sql`
        SELECT
          (SELECT count(*)::int FROM listings
            WHERE seller_id = ${userId} AND status = 'ACTIVE'
              AND moderation_status = 'APPROVED') AS active_listings,
          (SELECT count(*)::int FROM listings
            WHERE seller_id = ${userId} AND status = 'SOLD'
              AND governance_delisted_at IS NULL) AS sold_count
      `)
      const row = firstRowOf(result)
      if (!row) throw new Error('公开用户统计查询未返回行')
      return {
        activeListings: Number(row.active_listings),
        soldCount: Number(row.sold_count),
      }
    },

    async listListings(userId, status, limit, cursor) {
      const conditions: SQL[] = [
        eq(listings.sellerId, userId),
        // #565：口径由调用方给（在售 / 已售出）。已售出只认 `status = 'SOLD'`，
        // 与在售一样是"公开可读"的：售出是成交事实，不是下架。
        eq(listings.status, status),
      ]

      // 公开可见性的第二道闸，**只在在售段生效**（与 listings feed 的
      // `includeUnapproved: false` 同口径：只判 status 会把审核未通过的 ACTIVE 算进去）。
      //
      // 已售出段**不叠加** `moderationStatus = 'APPROVED'`（#565）：审核中 / 审核未通过
      // （REVIEW / BLOCKED）的商品成交后应当照常出现在「已售出」里，叠加审核列就会凭空
      // 少几件。（#565 复核订正：`confirm` 路径对**治理下架**商品是把 `status` 保成 OFFLINE
      // 而不是 SOLD，所以「治理期间成交 → 仍是 SOLD」这个说法只对核销路径成立。）
      //
      // 但**必须**筛掉平台治理下架的商品（#565 复核 H1）：核销路径
      // （`apps/api/src/modules/transactions/store.ts` 的核销 `UPDATE listings SET status = 'SOLD'`）
      // 无条件置 SOLD，治理下架时只写 `governance_delisted_at` + `moderation_status = 'BLOCKED'`
      // 且不取消在途交易 —— 于是存在 `status = 'SOLD'` 且 `governance_delisted_at != null` 的行。
      // 这类商品对非本人详情一律 404（`apps/api/src/modules/listings/service.ts` 的非卖家
      // OFFLINE 404 口径），若混进公开列表，匿名访客会拿到平台已下架商品的标题、价格、封面，
      // 点进去却是 404。在售段本来就被 APPROVED 闸挡着，已售段不筛反而更松。
      // 这里只认 `governance_delisted_at`（治理下架专用字段），不判 `moderation_status`。
      if (status === 'ACTIVE') conditions.push(eq(listings.moderationStatus, 'APPROVED'))
      else conditions.push(isNull(listings.governanceDelistedAt))

      if (cursor) conditions.push(cursorCondition(cursor))

      // innerJoin users（#191）：卡片要带卖家公开子集；`seller_id` 外键保证行存在，PK join 1:1。
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
          // 想要数（= 已建会话的买家数）：卡片契约的必填字段，主查询一次算完（见 `@fish/db/listing-wants`）。
          wants: listingWantsCount(listings.id),
          // 浏览量（近 30 天去重浏览人数）：与「想要数」并排画，同一取舍主查询一次算完。
          views: listingViewsCount(listings.id),
          seller: {
            id: users.id,
            nickname: users.nickname,
            avatarUrl: users.avatarUrl,
            authStatus: users.authStatus,
          },
        })
        .from(listings)
        .innerJoin(users, eq(users.id, listings.sellerId))
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
