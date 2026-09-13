import type { ListingCard } from '@fish/contracts/listings/schema'
import type { Db } from '@fish/db/client'
import { sql } from 'drizzle-orm'

/** 我发布的商品行（含封面 objectKey；URL 由共享映射 listings/card 拼）。 */
export interface ProfileListingRow {
  id: string
  title: string
  priceCents: number
  category: ListingCard['category']
  condition: ListingCard['condition']
  status: ListingCard['status']
  urgent: boolean
  negotiable: boolean
  free: boolean
  createdAt: Date
  coverObjectKey: string | null
}

/** 我的愿望行：形状对齐 wishes 模块的 WishRow（复用其导出的 toWishDto，避免映射漂移）。 */
export interface ProfileWishRow {
  id: string
  user_id: string
  keyword: string
  category: string
  budget_min_cents: number
  budget_max_cents: number
  description: string | null
  accept_similar: boolean
  status: string
  match_count: number
  created_at: Date | string
  updated_at: Date | string
}

export interface ProfileTransactionRow {
  id: string
  listingId: string
  buyerId: string
  amountCents: number
  status: string
  createdAt: Date | string
  /** 订单卡内嵌的商品摘要（join listings + 封面子查询）；脏数据行为 null 时由 service 跳过。 */
  listing: {
    title: string
    priceCents: number
    status: string
    coverObjectKey: string | null
  } | null
  /** 交易对方（查看者视角解析）；users 行缺失视为脏数据，由 service 跳过。 */
  counterpart: {
    id: string
    nickname: string
    avatarUrl: string | null
  } | null
}

export interface ProfileStatsRow {
  activeListings: number
  activeWishes: number
  completedTransactions: number
}

export interface ProfileStore {
  stats(userId: string): Promise<ProfileStatsRow>
  ownListings(userId: string, limit: number): Promise<ProfileListingRow[]>
  ownWishes(userId: string, limit: number): Promise<ProfileWishRow[]>
  ownTransactions(userId: string, limit: number): Promise<ProfileTransactionRow[]>
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}

export function createSqlProfileStore(db: Db): ProfileStore {
  return {
    async stats(userId) {
      // 统计口径必须与列表口径一致，否则个人中心会出现「统计 N 条、列表 M 条」的自相矛盾：
      // active_wishes 因此复用 ownWishes 的三项非空过滤（契约 WishDto 三者皆非空）。
      const result = await db.execute(sql`
        SELECT
          (SELECT count(*)::int FROM listings
            WHERE seller_id = ${userId} AND status = 'ACTIVE') AS active_listings,
          (SELECT count(*)::int FROM wishes
            WHERE user_id = ${userId} AND status = 'ACTIVE'
              AND category IS NOT NULL
              AND budget_min_cents IS NOT NULL
              AND budget_max_cents IS NOT NULL) AS active_wishes,
          (SELECT count(*)::int FROM transactions
            WHERE (buyer_id = ${userId} OR seller_id = ${userId}) AND status = 'COMPLETED')
            AS completed_transactions
      `)
      const row = rowsOf(result)[0]
      if (!row) throw new Error('Profile 统计查询未返回行')
      return {
        activeListings: Number(row.active_listings),
        activeWishes: Number(row.active_wishes),
        completedTransactions: Number(row.completed_transactions),
      }
    },

    async ownListings(userId, limit) {
      // 本人视角：不筛 status（OFFLINE/RESERVED/SOLD 都是自己可见的）。
      // 封面用相关子查询取最小 sort_order 的一张，与 listings 模块的读模型同一规则。
      const result = await db.execute(sql`
        SELECT l.id, l.title, l.price_cents, l.category::text AS category,
               l.condition::text AS condition, l.status::text AS status,
               l.urgent, l.negotiable, l.free, l.created_at,
               (SELECT li.object_key FROM listing_images li
                 WHERE li.listing_id = l.id AND li.sort_order = 0 LIMIT 1)
                 AS cover_object_key
        FROM listings l
        WHERE l.seller_id = ${userId}
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT ${limit}
      `)
      return rowsOf(result).map((row) => ({
        id: row.id as string,
        title: row.title as string,
        priceCents: row.price_cents as number,
        category: row.category as ProfileListingRow['category'],
        condition: row.condition as ProfileListingRow['condition'],
        status: row.status as ProfileListingRow['status'],
        urgent: Boolean(row.urgent),
        negotiable: Boolean(row.negotiable),
        free: Boolean(row.free),
        createdAt: row.created_at as Date,
        coverObjectKey: (row.cover_object_key as string | null) ?? null,
      }))
    },

    async ownWishes(userId, limit) {
      // category / budget 两端都可空（#2 为 #8 预留「不限分类/不限预算」），而契约的
      // WishDto 三者皆非空：过滤口径与 wishes 模块需求池聚合一致（category AND budget）。
      const result = await db.execute(sql`
        SELECT w.id, w.user_id, w.keyword, w.category::text AS category,
               w.budget_min_cents, w.budget_max_cents, w.description,
               w.accept_similar, w.status::text AS status, w.created_at, w.updated_at,
               (SELECT count(*)::int FROM matches m WHERE m.wish_id = w.id) AS match_count
        FROM wishes w
        WHERE w.user_id = ${userId}
          AND w.category IS NOT NULL
          AND w.budget_min_cents IS NOT NULL
          AND w.budget_max_cents IS NOT NULL
        ORDER BY w.created_at DESC, w.id DESC
        LIMIT ${limit}
      `)
      return rowsOf(result).map((row) => ({
        id: row.id as string,
        user_id: row.user_id as string,
        keyword: row.keyword as string,
        category: row.category as string,
        budget_min_cents: row.budget_min_cents as number,
        budget_max_cents: row.budget_max_cents as number,
        description: (row.description as string | null) ?? null,
        accept_similar: Boolean(row.accept_similar),
        status: row.status as string,
        match_count: Number(row.match_count),
        created_at: row.created_at as Date | string,
        updated_at: row.updated_at as Date | string,
      }))
    },

    async ownTransactions(userId, limit) {
      // 买入 + 卖出合并；role 与 counterpart 都由查看者（profile owner）视角判定
      // （buyer_id = me 即买入，对方是 seller，反之亦然——会话/交易的严格双人不变量）。
      // 内嵌摘要直接 join 已冻结的 listings/users 表（本域只读，不调用其他 Domain API）。
      // 封面口径与 ownListings / #6 契约 §1 一致：只有 `sort_order = 0` 才是封面；
      // 取不到 0 号图就返回 null，不能用序号更大的图片顶替。
      const result = await db.execute(sql`
        SELECT t.id, t.listing_id, t.buyer_id, t.amount_cents, t.status::text AS status,
               t.created_at,
               l.title AS listing_title, l.price_cents AS listing_price_cents,
               l.status::text AS listing_status,
               (SELECT li.object_key FROM listing_images li
                 WHERE li.listing_id = t.listing_id AND li.sort_order = 0 LIMIT 1)
                 AS listing_cover_key,
               u.id AS counterpart_id, u.nickname AS counterpart_nickname,
               u.avatar_url AS counterpart_avatar_url
        FROM transactions t
        JOIN listings l ON l.id = t.listing_id
        LEFT JOIN users u ON u.id = (CASE WHEN t.buyer_id = ${userId} THEN t.seller_id ELSE t.buyer_id END)
        WHERE t.buyer_id = ${userId} OR t.seller_id = ${userId}
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT ${limit}
      `)
      return rowsOf(result).map((row) => ({
        id: row.id as string,
        listingId: row.listing_id as string,
        buyerId: row.buyer_id as string,
        amountCents: row.amount_cents as number,
        status: row.status as string,
        createdAt: row.created_at as Date | string,
        listing: row.listing_title
          ? {
              title: row.listing_title as string,
              priceCents: row.listing_price_cents as number,
              status: row.listing_status as string,
              coverObjectKey: (row.listing_cover_key as string | null) ?? null,
            }
          : null,
        counterpart: row.counterpart_id
          ? {
              id: row.counterpart_id as string,
              nickname: row.counterpart_nickname as string,
              avatarUrl: (row.counterpart_avatar_url as string | null) ?? null,
            }
          : null,
      }))
    },
  }
}
