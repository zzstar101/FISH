import type { ListingCategory, ListingStatus } from '@fish/contracts/listings/schema'
import { MATCH_SCORE_THRESHOLD } from '@fish/contracts/matching/schema'
import type { Db } from '@fish/db/client'
import { listingImages, listings } from '@fish/db/schema/listings'
import { matches } from '@fish/db/schema/matches'
import { wishes } from '@fish/db/schema/wishes'
import { and, desc, eq, gte, ne, sql } from 'drizzle-orm'
import type { ListingCardSource } from '../listings/card'

/**
 * 匹配读路径的 SQL（Issue #8 契约评论 §2 / 补记 §9.1、§9.7）。
 *
 * 三个读时过滤，都不靠 `matches` 行本身干净：
 *
 * 1. **`score >= MATCH_SCORE_THRESHOLD`**：`matches` 行不删（契约 §5.3），而商品被编辑后重算会把
 *    分数**覆盖**成新值——分数跌出阈值的旧行如果不过滤，页面上就会出现一个"已经不该匹配"的卡片
 *    （补偿 #6 的"编辑/上架后重投 job"，见 #6 评论）；
 * 2. wish 侧排除 `OFFLINE` 商品（离线商品对非卖家 `GET /listings/:id` 返 404，而匹配卡片的自然交互
 *    是点进详情——不过滤就是死链）；`RESERVED` / `SOLD` 保留，卡片自带状态角标；
 * 3. `price <= 2 × budget_max`（`budget_max` 为 NULL = 不限）——与引擎候选集收窄**同一条产品规则**
 *    （补记 §9.8）。必须有这一条：既有 `matches` 行会被重算重新打分，但"分类与关键词满分、价格超 2 倍"
 *    的裸分恰好是 70（`0.35 + 0.35 + 0`），只靠 `score >= 阈值` 挡不住它，会出现"同一对，新建时不匹配、
 *    编辑后却可见"的历史相关行为。
 * 4. listing 侧只返回 `ACTIVE` 愿望，因为 `WishSummary` 里没有 status 字段，前端无法区分
 *    "还在求购"与"已经不需要了"。wish 侧刻意**不**过滤自己愿望的状态：那是本人自己的愿望，
 *    成真/关闭后仍能看到曾经匹配到的商品不算错（商品状态在卡片里可见）。
 *
 * 幂等与分数覆盖发生在写入侧（`apps/worker/src/jobs/matching/engine.ts`），这里只读。
 */

export type MatchTarget = { id: string; ownerId: string }

/** listing 方向多带一个 `status`：`OFFLINE` 对非卖家要按 404 处理（与 #6 同一口径）。 */
export type MatchListingTarget = MatchTarget & { status: ListingStatus }

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
  findListing(id: string): Promise<MatchListingTarget | null>
  countWishMatches(wishId: string): Promise<number>
  listWishMatches(wishId: string, limit: number): Promise<WishMatchEntry[]>
  countListingMatches(listingId: string): Promise<number>
  listListingMatches(listingId: string, limit: number): Promise<ListingMatchEntry[]>
}

/**
 * 价格可匹配性：`price <= 2 × budget_max`（`budget_max IS NULL` = 不限预算）。
 *
 * 与 `apps/worker/src/jobs/matching/engine.ts` 的候选集收窄是**同一条规则的两个表达**
 * （一个在 SQL、一个在 SQL+TS）。改这里必须同时改那边——这是本契约里唯一的规则重复点，
 * 因为 worker 与 api 是两个 app，没法共享 SQL 片段。
 */
const priceWithinBudget = sql`(${wishes.budgetMaxCents} IS NULL OR ${listings.priceCents}::bigint <= 2::bigint * ${wishes.budgetMaxCents})`

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
          .select({ id: listings.id, ownerId: listings.sellerId, status: listings.status })
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
        .innerJoin(wishes, eq(wishes.id, matches.wishId))
        .where(
          and(
            eq(matches.wishId, wishId),
            gte(matches.score, MATCH_SCORE_THRESHOLD),
            ne(listings.status, 'OFFLINE'),
            priceWithinBudget,
          ),
        )
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
        .innerJoin(wishes, eq(wishes.id, matches.wishId))
        .where(
          and(
            eq(matches.wishId, wishId),
            gte(matches.score, MATCH_SCORE_THRESHOLD),
            ne(listings.status, 'OFFLINE'),
            priceWithinBudget,
          ),
        )
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
        .innerJoin(listings, eq(listings.id, matches.listingId))
        .where(
          and(
            eq(matches.listingId, listingId),
            gte(matches.score, MATCH_SCORE_THRESHOLD),
            eq(wishes.status, 'ACTIVE'),
            priceWithinBudget,
          ),
        )
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
        .innerJoin(listings, eq(listings.id, matches.listingId))
        .where(
          and(
            eq(matches.listingId, listingId),
            gte(matches.score, MATCH_SCORE_THRESHOLD),
            eq(wishes.status, 'ACTIVE'),
            priceWithinBudget,
          ),
        )
        .orderBy(desc(matches.score), desc(matches.id))
        .limit(limit)
    },
  }
}
