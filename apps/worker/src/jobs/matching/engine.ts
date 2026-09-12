import type { ListingCategory } from '@fish/contracts/listings/schema'
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
 * 一次运行 = 「候选集收窄（SQL）→ 打分（纯函数）→ 对齐 `matches`（幂等）」。
 * 两个方向共用同一套打分与写入逻辑，只有"谁是候选"和"通知发给谁"不同。
 *
 * **"对齐"而不是"只补新行"**：收窄候选之外，该目标**已有匹配行**的那几对也要重新评估。
 * 否则商品被编辑（改分类/改价/改标题）或愿望被关闭后，旧行会永远停在旧分数上，
 * 而读接口按阈值过滤也就挡不住它（只加过滤是不够的）。
 *
 * 只读 `listings` / `wishes`、只写 `matches` / `notifications`：RESERVED / SOLD 的状态
 * 由交易域负责（#11），本模块不改商品状态。
 */

/** 目标行不存在 / 不再是可匹配状态时的原因；正常跑完为 `null`。 */
export type MatchSkipReason = 'target-missing' | 'target-not-active'

export type MatchRunResult = {
  /** 本轮**重新评估**过的对数：收窄候选 ∪ 已有匹配行，去重后。 */
  evaluated: number
  /** 达到阈值并被写入的对数（新建 + 覆盖）。 */
  matched: number
  /** 其中**首次**创建的条数（= 本轮建了几条通知；契约 §3.4）。 */
  created: number
  /**
   * 既有行被覆盖成**低于阈值**的分数（商品/愿望被编辑后不再匹配）。
   * 这些行不删（契约 §5.3），由读接口的 `score >= MATCH_SCORE_THRESHOLD` 过滤隐藏（补记 §9.7）。
   */
  downgraded: number
  skipped: MatchSkipReason | null
}

export interface MatchEngine {
  /** `MATCH_LISTING`：商品刚发布 / 被编辑 / 重新上架时，重算"想要它"的愿望。 */
  matchListing(listingId: string): Promise<MatchRunResult>
  /** `MATCH_WISH`：愿望刚创建时，找"能满足它"的商品。 */
  matchWish(wishId: string): Promise<MatchRunResult>
}

/** 打分只需要这几个字段，所以候选行与"已有匹配行"都投影成同一形状。 */
type WishTarget = {
  id: string
  userId: string
  keyword: string
  category: ListingCategory | null
  budgetMaxCents: number | null
}

type ListingTarget = {
  id: string
  title: string
  description: string
  priceCents: number
  category: ListingCategory
}

const ok = (
  evaluated: number,
  matched: number,
  created: number,
  downgraded: number,
): MatchRunResult => ({ evaluated, matched, created, downgraded, skipped: null })

const skipped = (reason: MatchSkipReason): MatchRunResult => ({
  evaluated: 0,
  matched: 0,
  created: 0,
  downgraded: 0,
  skipped: reason,
})

/*
 * 候选集的两个收窄条件在这里写成整段 SQL（两个方向的写法不同，就不抽 helper 了）：
 *
 * - 分类：`wish.category IS NULL`（不限分类）时放行全部；
 * - 价格：`price <= 2 × budget_max`。这是一条**产品规则**，不只是性能优化：超过 2 倍预算的候选
 *   **不参与匹配**，即使它分类与关键词都满分（那种情况总分恰好 70，本可以过阈值）。
 *   界限与 `scoring.ts` 里 `priceScore` 归零的位置相同，但不能读成"只排除 priceScore = 0 的候选"。
 *   用 `::bigint` 是因为 `integer` 列上 `2 * max` 会溢出（PG 22003 直接 500）。
 */

export function createMatchEngine(db: Db): MatchEngine {
  type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

  /**
   * 写入一对匹配。
   *
   * - `score >= 阈值`：`ON CONFLICT DO NOTHING RETURNING id` —— 真的返回了行（首次）才建通知（#2 的规则）；
   *   否则 `UPDATE` 覆盖分数（`matches.ts:9`："#8 重算时 upsert 覆盖分数"）。
   * - `score < 阈值` **且已有行**：只把分数覆盖为真实值，不建通知。**必须覆盖**——否则整行的旧分数
   *   仍是 ≥ 阈值，读接口的阈值过滤就再也看不到它（契约 §5.3 的"不删行"靠这条覆盖 + 读接口过滤成立）。
   * - `score < 阈值` 且**没有行**：什么都不做（不为一个不成立的匹配新建行）。
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
      /** 该对在**本轮评估之前**是否已有 `matches` 行。 */
      hadRow: boolean
      breakdown: ReturnType<typeof scoreMatch>
    },
  ): Promise<'created' | 'updated' | 'skipped'> {
    const { score, categoryScore, keywordScore, priceScore } = input.breakdown
    const qualifies = score >= MATCH_SCORE_THRESHOLD
    if (!qualifies && !input.hadRow) return 'skipped'

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
    if (row) {
      // 只有真的达到阈值的匹配才通知——不为一个不成立的匹配发通知。
      if (qualifies) {
        await tx.insert(notifications).values({
          userId: input.wishOwnerId,
          type: 'MATCH',
          payload: jsonParam({
            matchId: row.id,
            listingId: input.listingId,
            wishId: input.wishId,
          }),
        })
      }
      return 'created'
    }

    await tx
      .update(matches)
      .set({ score, categoryScore, keywordScore, priceScore })
      .where(and(eq(matches.listingId, input.listingId), eq(matches.wishId, input.wishId)))
    return 'updated'
  }

  /** 把「本轮评估集合」跑完：打分 → 写入 → 计数。 */
  async function applyTargets(
    targetListing: ListingTarget,
    targets: Map<string, { wish: WishTarget; hadRow: boolean }>,
  ): Promise<MatchRunResult> {
    const listingFacts: MatchListingFacts = {
      title: targetListing.title,
      description: targetListing.description,
      priceCents: targetListing.priceCents,
      category: targetListing.category,
    }

    let matched = 0
    let created = 0
    let downgraded = 0

    await db.transaction(async (tx) => {
      for (const { wish, hadRow } of targets.values()) {
        const breakdown = scoreMatch(listingFacts, {
          keyword: wish.keyword,
          category: wish.category,
          budgetMaxCents: wish.budgetMaxCents,
        })
        const outcome = await persist(tx, {
          listingId: targetListing.id,
          wishId: wish.id,
          wishOwnerId: wish.userId,
          hadRow,
          breakdown,
        })
        if (outcome === 'skipped') continue

        if (breakdown.score >= MATCH_SCORE_THRESHOLD) matched += 1
        else downgraded += 1
        if (outcome === 'created') created += 1
      }
    })

    return ok(targets.size, matched, created, downgraded)
  }

  return {
    async matchListing(listingId) {
      const listing = (
        await db.select().from(listings).where(eq(listings.id, listingId)).limit(1)
      )[0]
      if (!listing) return skipped('target-missing')
      // 下架 / 已被锁定 / 已售的商品不该再产生新匹配（契约 §3.1）。
      if (listing.status !== 'ACTIVE') return skipped('target-not-active')

      const [candidates, existingRows] = await Promise.all([
        db
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
          ),
        db
          .select({
            id: wishes.id,
            userId: wishes.userId,
            keyword: wishes.keyword,
            category: wishes.category,
            budgetMaxCents: wishes.budgetMaxCents,
          })
          .from(matches)
          .innerJoin(wishes, eq(wishes.id, matches.wishId))
          .where(eq(matches.listingId, listing.id)),
      ])

      const existingIds = new Set(existingRows.map((row) => row.id))
      const targets = new Map<string, { wish: WishTarget; hadRow: boolean }>()
      for (const wish of candidates) {
        targets.set(wish.id, { wish, hadRow: existingIds.has(wish.id) })
      }
      for (const row of existingRows) {
        // 已经掉出收窄集合（改分类、超 2 倍预算、愿望已关闭…）但行还在：也要按真实分数重新评估。
        if (!targets.has(row.id)) targets.set(row.id, { wish: row, hadRow: true })
      }

      return applyTargets(
        {
          id: listing.id,
          title: listing.title,
          description: listing.description,
          priceCents: listing.priceCents,
          category: listing.category,
        },
        targets,
      )
    },

    async matchWish(wishId) {
      const wish = (await db.select().from(wishes).where(eq(wishes.id, wishId)).limit(1))[0]
      if (!wish) return skipped('target-missing')
      // 已关闭 / 已满足的愿望不再拉新匹配（与愿望池只统计 ACTIVE 同一取向）。
      if (wish.status !== 'ACTIVE') return skipped('target-not-active')

      const [candidates, existingRows] = await Promise.all([
        db
          .select()
          .from(listings)
          .where(
            and(
              eq(listings.status, 'ACTIVE'),
              ne(listings.sellerId, wish.userId),
              /*
               * 不限分类 → 不生成条件。
               *
               * 不能写成 `sql`(${wish.category} IS NULL OR ...)``：`wish.category` 是**值**，
               * `$n IS NULL OR col = $n` 会让 PG 推不出参数类型（实测 42P18）。
               */
              wish.category === null ? undefined : eq(listings.category, wish.category),
              wish.budgetMaxCents === null
                ? undefined
                : sql`${listings.priceCents}::bigint <= 2::bigint * ${wish.budgetMaxCents}`,
            ),
          ),
        db
          .select({
            id: listings.id,
            title: listings.title,
            description: listings.description,
            priceCents: listings.priceCents,
            category: listings.category,
          })
          .from(matches)
          .innerJoin(listings, eq(listings.id, matches.listingId))
          .where(eq(matches.wishId, wish.id)),
      ])

      const existingIds = new Set(existingRows.map((row) => row.id))
      const targets = new Map<string, { listing: ListingTarget; hadRow: boolean }>()
      for (const listing of candidates) {
        targets.set(listing.id, { listing, hadRow: existingIds.has(listing.id) })
      }
      for (const row of existingRows) {
        // 已下架 / 已售 / 超预算的商品不再参与匹配，但已有行仍要按真实分数覆盖。
        if (!targets.has(row.id)) targets.set(row.id, { listing: row, hadRow: true })
      }

      const wishFacts = {
        keyword: wish.keyword,
        category: wish.category,
        budgetMaxCents: wish.budgetMaxCents,
      }

      let matched = 0
      let created = 0
      let downgraded = 0

      await db.transaction(async (tx) => {
        for (const { listing, hadRow } of targets.values()) {
          const breakdown = scoreMatch(
            {
              title: listing.title,
              description: listing.description,
              priceCents: listing.priceCents,
              category: listing.category,
            },
            wishFacts,
          )
          const outcome = await persist(tx, {
            listingId: listing.id,
            wishId: wish.id,
            wishOwnerId: wish.userId,
            hadRow,
            breakdown,
          })
          if (outcome === 'skipped') continue

          if (breakdown.score >= MATCH_SCORE_THRESHOLD) matched += 1
          else downgraded += 1
          if (outcome === 'created') created += 1
        }
      })

      return ok(targets.size, matched, created, downgraded)
    },
  }
}
