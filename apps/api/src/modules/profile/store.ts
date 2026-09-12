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
      const result = await db.execute(sql`
        SELECT
          (SELECT count(*)::int FROM listings
            WHERE seller_id = ${userId} AND status = 'ACTIVE') AS active_listings,
          (SELECT count(*)::int FROM wishes
            WHERE user_id = ${userId} AND status = 'ACTIVE') AS active_wishes,
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
      // 买入 + 卖出合并；role 由 service 按 buyerId 判定（transaction 的 seller 由
      // listing 决定，buyer_id = me 即买入，否则卖出——会话/交易的严格双人不变量）。
      const result = await db.execute(sql`
        SELECT t.id, t.listing_id, t.buyer_id, t.amount_cents, t.status::text AS status,
               t.created_at
        FROM transactions t
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
      }))
    },
  }
}
