import type { ListingCard } from '@fish/contracts/listings/schema'
import type { Db } from '@fish/db/client'
import { listingViewsCount } from '@fish/db/listing-views'
import { listingWantsCount } from '@fish/db/listing-wants'
import { favorites } from '@fish/db/schema/favorites'
import { listings } from '@fish/db/schema/listings'
import { users } from '@fish/db/schema/users'
import { and, desc, eq, lt, or, type SQL, sql } from 'drizzle-orm'
import type { ListingCardSource } from '../listings/card'
import type { FavoritesCursor } from './cursor'

/**
 * 收藏关系的持久化（Issue #190）。表与两条索引由 #287 落地（`packages/db/src/schema/favorites.ts`）。
 *
 * ## 幂等靠 DB 唯一约束，不靠先读后写
 *
 * `POST` 用 `ON CONFLICT DO NOTHING`、`DELETE` 用无条件删 —— 两者都不需要「先查有没有」。
 * 先读后写在并发下会漏（两个请求同时读到"没有"，一个插入成功、另一个撞 23505 变成 500）。
 *
 * ## 卡片投影复用 `listings/card.ts`
 *
 * `listFavorites` 只 SELECT `ListingCardSource` 需要的列 + 封面对象键，
 * 映射交给共享的 `toListingCard`（`profile` / `matching` / `users` 同一实现）——
 * 卡片形状、`listingNo` 的 bigint→string、脏行跳过都只有一份。
 *
 * ## 排序与索引
 *
 * `(favorites.created_at DESC, listings.id DESC)`：`favorites_user_id_created_at_id_idx`
 * 的第三列是 `favorites.id`，所以这个索引**只覆盖 `(user_id, created_at)` 前缀**，
 * 末列的 tie-break（商品 id）是在同 `created_at` 的分组内现排的 —— 分组通常极小，代价可忽略，
 * 但别把它读成"索引已覆盖全部排序列"。顺序是全序（`(user_id, listing_id)` 唯一），
 * 所以 `(created_at, listing_id)` 游标不重不漏。
 */

/** 收藏列表的一行：卡片源 + 封面键 + 两个时间戳（对外一个、构造游标一个）。 */
export interface FavoriteRow extends ListingCardSource {
  coverObjectKey: string | null
  /** 毫秒精度 ISO 文本，直接进契约的 `z.iso.datetime()`（不经过 `Date`，避免精度与本地时区干扰）。 */
  favoritedAt: string
  /** 微秒精度的 `favorites.created_at` UTC ISO 文本，仅供构造游标。 */
  favoritedAtCursor: string
}

/**
 * 商品状态投影：够服务层判「能不能收藏」与「能不能被当前浏览者看到」两件事。
 *
 * 为什么要有 `sellerId` / `moderationStatus`：详情页的可见性判据是
 * 「`status !== OFFLINE` 且审核通过，或者是卖家本人」（`listings/service.ts` 的 `loadDetail`）。
 * 读收藏态必须沿用**同一个**判据，否则要么读不到 SOLD/RESERVED 商品的状态，
 * 要么给「某个 id 是否存在且下架」留出探针。
 */
export interface FavoriteListingState {
  status: ListingCard['status']
  /** 与契约 / DB 同源，不另写一份枚举联合（增删枚举值时这里跟着编译报错）。 */
  moderationStatus: ListingCard['moderationStatus']
  governanceDelistedAt: Date | null
  sellerId: string
}

export interface FavoriteStore {
  /** 商品是否存在；不存在 → 404（不泄漏"格式错"与"不存在"的差异）。 */
  listingState(listingId: string): Promise<FavoriteListingState | null>
  /** 我是否收藏了它。 */
  isFavorited(userId: string, listingId: string): Promise<boolean>
  /** 我收藏的商品，多取一行由调用方判断还有没有下一页。 */
  listFavorites(
    userId: string,
    limit: number,
    cursor: FavoritesCursor | null,
  ): Promise<FavoriteRow[]>
  /** 全量计数，与 `listFavorites` 同一张表、同一个方向。 */
  totalFavorites(userId: string): Promise<number>
  /** 幂等收藏（已存在则不动，不改写首次 created_at）。 */
  addFavorite(userId: string, listingId: string): Promise<void>
  /** 幂等取消（不存在也是成功）。 */
  removeFavorite(userId: string, listingId: string): Promise<void>
}

/** `(created_at, 商品 id) < (cursor)`，与 `created_at DESC, listings.id DESC` 同向。 */
function cursorCondition(cursor: FavoritesCursor): SQL {
  return or(
    sql`${favorites.createdAt} < ${cursor.createdAt}::timestamptz`,
    and(
      sql`${favorites.createdAt} = ${cursor.createdAt}::timestamptz`,
      lt(listings.id, cursor.listingId),
    ),
  ) as SQL
}

export function createSqlFavoriteStore(db: Db): FavoriteStore {
  return {
    async listingState(listingId) {
      const rows = await db
        .select({
          status: listings.status,
          moderationStatus: listings.moderationStatus,
          governanceDelistedAt: listings.governanceDelistedAt,
          sellerId: listings.sellerId,
        })
        .from(listings)
        .where(eq(listings.id, listingId))
        .limit(1)
      return rows[0] ?? null
    },

    async isFavorited(userId, listingId) {
      const rows = await db
        .select({ id: favorites.id })
        .from(favorites)
        .where(and(eq(favorites.userId, userId), eq(favorites.listingId, listingId)))
        .limit(1)
      return rows.length > 0
    },

    async listFavorites(userId, limit, cursor) {
      const conditions: SQL[] = [eq(favorites.userId, userId)]
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
            // 卖家公开子集（#191 的 `ListingCardSource.seller`，本 PR 补齐）：与 feed / 详情
            // 同一 inner join 同源投影 —— 收藏列表里的卡片也要能直接渲染卖家（昵称 / 头像 /
            // 认证态），不逐卡补查。`listings.seller_id` 外键保证行存在，PK join 是 1:1，
            // 不影响分页、游标与排序。
            seller: {
              id: users.id,
              nickname: users.nickname,
              avatarUrl: users.avatarUrl,
              authStatus: users.authStatus,
            },
            // 封面只认 `sort_order = 0`（#6 契约 §1：下标即 sortOrder，0 才是封面），
            // 与 listings feed / matching / profile 同一口径；取不到就是 null，不用更大的序号顶替。
            coverObjectKey: sql<
              string | null
            >`(SELECT li.object_key FROM listing_images li WHERE li.listing_id = ${listings.id} AND li.sort_order = 0 LIMIT 1)`,
            // 想要数（= 已建会话的买家数）：卡片契约的必填字段，主查询一次算完（见 `@fish/db/listing-wants`）。
            wants: listingWantsCount(listings.id),
            // 浏览量（近 30 天去重浏览人数）：同一张卡上与「想要数」并排画，同样主查询一次算完。
            views: listingViewsCount(listings.id),
            // 毫秒给契约、微秒给游标：JS `Date` 只有毫秒，而 `created_at` 是 timestamptz（微秒），
            // 游标必须保留微秒才不重不漏；对外那个字段反过来只需要毫秒（`z.iso.datetime()` 的形状）。
            favoritedAt: sql<string>`to_char(${favorites.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
            favoritedAtCursor: sql<string>`to_char(${favorites.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          })
          .from(favorites)
          .innerJoin(listings, eq(listings.id, favorites.listingId))
          .innerJoin(users, eq(users.id, listings.sellerId))
          .where(and(...conditions))
          .orderBy(desc(favorites.createdAt), desc(listings.id))
          // 多取一行用于判断"还有没有下一页"，返回前丢掉（与 listings feed 同款）。
          .limit(limit + 1)
      )
    },

    async totalFavorites(userId) {
      const rows = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(favorites)
        .where(eq(favorites.userId, userId))
      return Number(rows[0]?.total ?? 0)
    },

    async addFavorite(userId, listingId) {
      // `ON CONFLICT DO NOTHING` 命中 (user_id, listing_id) 唯一索引 → 幂等，
      // 且不改写首次 created_at（列表顺序因此稳定）。
      await db.insert(favorites).values({ userId, listingId }).onConflictDoNothing()
    },

    async removeFavorite(userId, listingId) {
      await db
        .delete(favorites)
        .where(and(eq(favorites.userId, userId), eq(favorites.listingId, listingId)))
    },
  }
}
