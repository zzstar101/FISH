import type { ListingCategory } from '@fish/contracts/listings/schema'
import type { Db } from '@fish/db/client'
import { listingImages, listings } from '@fish/db/schema/listings'
import { matches } from '@fish/db/schema/matches'
import { wishes } from '@fish/db/schema/wishes'
import { and, desc, eq, ne, sql } from 'drizzle-orm'
import type { ListingCardSource } from '../listings/card'

/**
 * 匹配读路径的 SQL（Issue #8 契约评论 §2）。
 *
 * 两个查询都带**读时可见性过滤**，而不是靠 `matches` 行本身干净：
 *
 * - wish 侧排除 `OFFLINE` 商品（离线商品对非卖家 `GET /listings/:id` 返 404，
 *   而匹配卡片的自然交互是点进详情——不过滤就是死链。`RESERVED` / `SOLD` 保留，卡片自带状态角标）；
 * - listing 侧排除已关闭 / 已满足的愿望，因为 `WishSummary` 里没有 status 字段，
 *   前端无法区分"还在求购"与"已经不需要了"（契约评论 §5.4）。
 *
 * 幂等与分数覆盖发生在写入侧（`apps/worker/src/jobs/matching/engine.ts`），这里只读。
 */

export type MatchTarget = { id: string; ownerId: string }

export type WishMatchEntry = {
  matchId: string
  score: number
  createdAt: Date
  listing: ListingCardSource
  coverObjectKey: string | null
}

export type ListingMatchEntry = {
  matchId: string
  score: number
  createdAt: Date
  wish: {
    id: string
    keyword: string
    category: ListingCategory | null
    budgetMinCents: number | null
    budgetMaxCents: number | null
  }
}

export interface MatchingStore {
  /** 目标是否存在与归属（404 与 403 的区分要在 service 层做，所以 owner 也要取回来）。 */
  findWish(id: string): Promise<MatchTarget | null>
  findListing(id: string): Promise<MatchTarget | null>
  countWishMatches(wishId: string): Promise<number>
  listWishMatches(wishId: string, limit: number): Promise<WishMatchEntry[]>
  countListingMatches(listingId: string): Promise<number>
  listListingMatches(listingId: string, limit: number): Promise<ListingMatchEntry[]>
}

/** 封面 = `sort_order = 0`（与 #6 的 feed 同一约定）。 */
const coverObjectKey = sql<string | null>`(
  SELECT ${listingImages.objectKey} FROM ${listingImages}
  WHERE ${listingImages.listingId} = ${listings.id} AND ${listingImages.sortOrder} = 0
)`

export function createSqlMatchingStore(db: Db): MatchingStore {
  return {
    async findWish(id) {
      const row = (
        await db
          .select({ id: wishes.id, ownerId: wishes.userId })
          .from(wishes)
          .where(eq(wishes.id, id))
          .limit(1)
      )[0]
      return row ?? null
    },

    async findListing(id) {
      const row = (
        await db
          .select({ id: listings.id, ownerId: listings.sellerId })
          .from(listings)
          .where(eq(listings.id, id))
          .limit(1)
      )[0]
      return row ?? null
    },

    async countWishMatches(wishId) {
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(matches)
        .innerJoin(listings, eq(listings.id, matches.listingId))
        .where(and(eq(matches.wishId, wishId), ne(listings.status, 'OFFLINE')))
      return rows[0]?.count ?? 0
    },

    async listWishMatches(wishId, limit) {
      const rows = await db
        .select({
          matchId: matches.id,
          score: matches.score,
          createdAt: matches.createdAt,
          coverObjectKey,
          listing: {
            id: listings.id,
            title: listings.title,
            priceCents: listings.priceCents,
            category: listings.category,
            condition: listings.condition,
            status: listings.status,
            urgent: listings.urgent,
            negotiable: listings.negotiable,
            free: listings.free,
            createdAt: listings.createdAt,
          },
        })
        .from(matches)
        .innerJoin(listings, eq(listings.id, matches.listingId))
        .where(and(eq(matches.wishId, wishId), ne(listings.status, 'OFFLINE')))
        // tie-break 用 id：同分时取 Top N 不能抖动（契约 §2.1）。
        .orderBy(desc(matches.score), desc(matches.id))
        .limit(limit)

      return rows.map((row) => ({ ...row, coverObjectKey: row.coverObjectKey ?? null }))
    },

    async countListingMatches(listingId) {
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(matches)
        .innerJoin(wishes, eq(wishes.id, matches.wishId))
        .where(and(eq(matches.listingId, listingId), eq(wishes.status, 'ACTIVE')))
      return rows[0]?.count ?? 0
    },

    async listListingMatches(listingId, limit) {
      return db
        .select({
          matchId: matches.id,
          score: matches.score,
          createdAt: matches.createdAt,
          wish: {
            id: wishes.id,
            keyword: wishes.keyword,
            category: wishes.category,
            budgetMinCents: wishes.budgetMinCents,
            budgetMaxCents: wishes.budgetMaxCents,
          },
        })
        .from(matches)
        .innerJoin(wishes, eq(wishes.id, matches.wishId))
        .where(and(eq(matches.listingId, listingId), eq(wishes.status, 'ACTIVE')))
        .orderBy(desc(matches.score), desc(matches.id))
        .limit(limit)
    },
  }
}
