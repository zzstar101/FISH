import { MATCH_SCORE_THRESHOLD } from '@fish/contracts/matching/schema'
import type { Db } from '@fish/db/client'
import { jsonParam } from '@fish/db/json'
import { listings } from '@fish/db/schema/listings'
import { matches } from '@fish/db/schema/matches'
import { notifications } from '@fish/db/schema/notifications'
import { wishes } from '@fish/db/schema/wishes'
import { and, eq, ne, sql } from 'drizzle-orm'
import { type MatchListingFacts, scoreMatch } from './scoring'

/**
 * Match Engine（Issue #8 契约评论 §3）。
 *
 * 一次运行 = 「候选集收窄（SQL）→ 打分（纯函数）→ 落库 + 通知（幂等）」。
 * 两个方向共用同一套打分与写入逻辑，只有"谁是候选"和"通知发给谁"不同。
 *
 * 只读 `listings` / `wishes`、只写 `matches` / `notifications`：RESERVED / SOLD 的状态
 * 由交易域负责（#11），本模块不改商品状态。
 */

/** 目标行不存在 / 不再是可匹配状态时的原因；正常跑完为 `null`。 */
export type MatchSkipReason = 'target-missing' | 'target-not-active'

export type MatchRunResult = {
  /** 候选集大小（收窄之后、打分之前）。 */
  candidates: number
  /** 达到阈值并写入的匹配数（新建 + 覆盖）。 */
  matched: number
  /** 其中**首次**创建的条数（= 本轮建了几条通知；契约 §3.4）。 */
  created: number
  skipped: MatchSkipReason | null
}

export interface MatchEngine {
  /** `MATCH_LISTING`：商品刚发布（或重复发布）时，找"想要它"的愿望。 */
  matchListing(listingId: string): Promise<MatchRunResult>
  /** `MATCH_WISH`：愿望刚创建时，找"能满足它"的商品。 */
  matchWish(wishId: string): Promise<MatchRunResult>
}

const ok = (candidates: number, matched: number, created: number): MatchRunResult => ({
  candidates,
  matched,
  created,
  skipped: null,
})

const skipped = (reason: MatchSkipReason): MatchRunResult => ({
  candidates: 0,
  matched: 0,
  created: 0,
  skipped: reason,
})

/*
 * 候选集的两个收窄条件在这里写成整段 SQL（两个方向的写法不同，就不抽 helper 了）：
 *
 * - 分类：`wish.category IS NULL`（不限分类）时放行全部；
 * - 价格：`price <= 2 × budget_max`。界限与 `scoring.ts` 里 `priceScore` 归零的位置**必须是同一个数**，
 *   否则候选集里会出现必然 0 分的行。用 `::bigint` 是因为 `integer` 列上 `2 * max` 会溢出（PG 22003 直接 500）。
 */

export function createMatchEngine(db: Db): MatchEngine {
  type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

  /**
   * 写入一对匹配：**先** `ON CONFLICT DO NOTHING RETURNING id`，真的返回了行才建通知（#2 定的规则）；
   * 已经是既有行时走 `UPDATE` 覆盖分数（`matches.ts:9`："#8 重算时 upsert 覆盖分数"）。
   *
   * 不用 `DO UPDATE ... RETURNING` + `xmax = 0` 那条捷径：它依赖 PG 的实现细节，
   * 而且会让"重算也建通知"变成一个很容易踩中的坑。
   */
  async function persist(
    tx: Tx,
    input: {
      listingId: string
      wishId: string
      /** 通知收件人 = 愿望所有者（契约 §3.4：卖家侧不产生通知）。 */
      wishOwnerId: string
      breakdown: ReturnType<typeof scoreMatch>
    },
  ): Promise<'created' | 'updated'> {
    const { score, categoryScore, keywordScore, priceScore } = input.breakdown

    const inserted = await tx
      .insert(matches)
      .values({
        listingId: input.listingId,
        wishId: input.wishId,
        score,
        categoryScore,
        keywordScore,
        priceScore,
      })
      .onConflictDoNothing({ target: [matches.listingId, matches.wishId] })
      .returning({ id: matches.id })

    const row = inserted[0]
    if (!row) {
      await tx
        .update(matches)
        .set({ score, categoryScore, keywordScore, priceScore })
        .where(and(eq(matches.listingId, input.listingId), eq(matches.wishId, input.wishId)))
      return 'updated'
    }

    await tx.insert(notifications).values({
      userId: input.wishOwnerId,
      type: 'MATCH',
      payload: jsonParam({
        matchId: row.id,
        listingId: input.listingId,
        wishId: input.wishId,
      }),
    })
    return 'created'
  }

  return {
    async matchListing(listingId) {
      const listing = (
        await db.select().from(listings).where(eq(listings.id, listingId)).limit(1)
      )[0]
      if (!listing) return skipped('target-missing')
      // 下架 / 已被锁定 / 已售的商品不该再产生新匹配（契约 §3.1）。
      if (listing.status !== 'ACTIVE') return skipped('target-not-active')

      const listingFacts: MatchListingFacts = {
        title: listing.title,
        description: listing.description,
        priceCents: listing.priceCents,
        category: listing.category,
      }

      const candidates = await db
        .select()
        .from(wishes)
        .where(
          and(
            eq(wishes.status, 'ACTIVE'),
            // 自己的愿望不吃自己的商品。
            ne(wishes.userId, listing.sellerId),
            sql`(${wishes.category} IS NULL OR ${wishes.category} = ${listing.category})`,
            sql`(${wishes.budgetMaxCents} IS NULL OR ${listing.priceCents}::bigint <= 2::bigint * ${wishes.budgetMaxCents})`,
          ),
        )

      let matched = 0
      let created = 0
      await db.transaction(async (tx) => {
        for (const wish of candidates) {
          const breakdown = scoreMatch(listingFacts, {
            keyword: wish.keyword,
            category: wish.category,
            budgetMaxCents: wish.budgetMaxCents,
          })
          if (breakdown.score < MATCH_SCORE_THRESHOLD) continue

          const outcome = await persist(tx, {
            listingId: listing.id,
            wishId: wish.id,
            wishOwnerId: wish.userId,
            breakdown,
          })
          matched += 1
          if (outcome === 'created') created += 1
        }
      })

      return ok(candidates.length, matched, created)
    },

    async matchWish(wishId) {
      const wish = (await db.select().from(wishes).where(eq(wishes.id, wishId)).limit(1))[0]
      if (!wish) return skipped('target-missing')
      // 已关闭 / 已满足的愿望不再拉新匹配（与愿望池只统计 ACTIVE 同一取向）。
      if (wish.status !== 'ACTIVE') return skipped('target-not-active')

      const candidates = await db
        .select()
        .from(listings)
        .where(
          and(
            eq(listings.status, 'ACTIVE'),
            ne(listings.sellerId, wish.userId),
            /*
             * 不限分类 → 不生成条件。
             *
             * 不能写成 `sql`(${wish.category} IS NULL OR ...)``：`wish.category` 为 `null` 时
             * drizzle 会把它当**绑定参数**传给 PG，而 `NULL = $n` 里的 $n 无法推断类型，
             * PG 直接报 42P18 `could not determine data type of parameter`。
             */
            wish.category === null ? undefined : eq(listings.category, wish.category),
            wish.budgetMaxCents === null
              ? undefined
              : sql`${listings.priceCents}::bigint <= 2::bigint * ${wish.budgetMaxCents}`,
          ),
        )

      let matched = 0
      let created = 0
      await db.transaction(async (tx) => {
        for (const listing of candidates) {
          const breakdown = scoreMatch(
            {
              title: listing.title,
              description: listing.description,
              priceCents: listing.priceCents,
              category: listing.category,
            },
            {
              keyword: wish.keyword,
              category: wish.category,
              budgetMaxCents: wish.budgetMaxCents,
            },
          )
          if (breakdown.score < MATCH_SCORE_THRESHOLD) continue

          const outcome = await persist(tx, {
            listingId: listing.id,
            wishId: wish.id,
            wishOwnerId: wish.userId,
            breakdown,
          })
          matched += 1
          if (outcome === 'created') created += 1
        }
      })

      return ok(candidates.length, matched, created)
    },
  }
}
