import type { ListingCategory, ListingStatus } from '@fish/contracts/listings/schema'
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
  /** 本轮写入且**读接口会展示**的对数（新建 + 覆盖）。 */
  matched: number
  /** 其中**首次**创建的条数（= 本轮真正建的通知条数；契约 §3.4）。 */
  created: number
  /**
   * 本轮写入但读接口**不会展示**的既有行条数：分数不够，或不满足读谓词（对端状态、价格收窄）。
   * 是"本轮被重新打分的条数"，不是"状态发生转变的条数"——已经不可见的行再算一次仍会 +1。
   */
  downgraded: number
  /** 目标不存在 / 不再是可匹配状态时的原因；正常跑完为 `null`。 */
  skipped: MatchSkipReason | null
}

/*
 * 不变式：`matched + downgraded <= evaluated`，差额 = "评估了但没有写入"的对
 * （不可新建且没有既有行 → `persist` 返回 `skipped`）。另有 `created <= matched`。
 * **这些计数只在同一方向的运行之间可比**：非 ACTIVE 的愿望永远不会有一轮 `matchWish`
 * （直接 `skipped`），它在 wish 侧读接口仍在展示，却只会被 `matchListing` 那轮计成 `downgraded`。
 *
 * 计数按**本轮方向的读接口可见性**分类（`matchListing` → `/matches?listingId=`；
 * `matchWish` → `/matches?wishId=`），而不是按引擎内部的 `qualifies`：可见性策略是方向相关的
 * （wish 侧保留 RESERVED/SOLD、listing 侧只显示 ACTIVE 愿望），拿内部判据计数就会得出
 * "引擎说无效、接口却在展示"的矛盾读数——审查抓过两次。
 */

export interface MatchEngine {
  /** `MATCH_LISTING`：商品刚发布 / 被编辑 / 重新上架时，重算"想要它"的愿望。 */
  matchListing(listingId: string): Promise<MatchRunResult>
  /** `MATCH_WISH`：愿望刚创建时，找"能满足它"的商品。 */
  matchWish(wishId: string): Promise<MatchRunResult>
}

/** 打分与收窄只需要这几个字段，所以候选行与"已有匹配行"都投影成同一形状。 */
type WishTarget = {
  id: string
  userId: string
  keyword: string
  status: typeof wishes.$inferSelect.status
  category: ListingCategory | null
  budgetMaxCents: number | null
}

type ListingTarget = {
  id: string
  sellerId: string
  title: string
  description: string
  priceCents: number
  category: ListingCategory
  status: ListingStatus
  moderationStatus: 'APPROVED' | 'BLOCKED' | 'REVIEW'
}

/**
 * 能否**新建**这一对：候选集收窄规则（§3.1）的 TS 镜像，与两个候选 SQL 逐条对应。
 *
 * 它只决定"要不要 INSERT、要不要发通知"（`qualifies`）。**不要**拿它去判断"读接口会不会展示"——
 * 可见性是方向相关的（见下面两个函数），两者不是同一件事，混用会让同一对事实出现
 * "新建时不可见、先建行后编辑却可见"的历史相关行为（审查抓过两次）。
 */
function creatable(wish: WishTarget, listing: ListingTarget): boolean {
  return (
    wish.status === 'ACTIVE' &&
    listing.status === 'ACTIVE' &&
    listing.moderationStatus === 'APPROVED' &&
    wish.userId !== listing.sellerId &&
    (wish.category === null || wish.category === listing.category) &&
    (wish.budgetMaxCents === null || listing.priceCents <= 2 * wish.budgetMaxCents)
  )
}

/** 与 `apps/api/src/modules/matching/store.ts` 的读谓词同一条：`price <= 2 × budget_max`。 */
function priceWithinBudget(wish: WishTarget, listing: ListingTarget): boolean {
  return wish.budgetMaxCents === null || listing.priceCents <= 2 * wish.budgetMaxCents
}

/**
 * `GET /matches?wishId=` 会不会展示这一对（镜像 wish 侧读谓词）：
 * 愿望本身必须 `ACTIVE`；`OFFLINE` 商品隐藏，`RESERVED` / `SOLD` **保留**（商品状态在卡片里可见）。
 *
 * ⚠️ 商品状态这一项比"可新建"更宽：新建要求商品 `ACTIVE`（§3.1 收窄），展示不要求。所以
 * **`RESERVED`/`SOLD` 的商品只对它已经有行的那一对可见**（先建行、后转状态），当时没建过行的
 * 那对永远不会出现。这是刻意接受的取舍（两条规则分别由契约 §3.1 与补记 §9.1 冻结），
 * 要消除它只能二选一：读接口连 `RESERVED`/`SOLD` 一起隐藏，或者允许为 ACTIVE 之外的商品建行。
 */
function visibleToWishOwner(wish: WishTarget, listing: ListingTarget, score: number): boolean {
  return (
    score >= MATCH_SCORE_THRESHOLD &&
    wish.status === 'ACTIVE' &&
    listing.status !== 'OFFLINE' &&
    listing.moderationStatus === 'APPROVED' &&
    priceWithinBudget(wish, listing)
  )
}

/**
 * `GET /matches?listingId=` 会不会展示这一对（镜像 listing 侧读谓词）：
 * 只展示仍 `ACTIVE` 的（他人的）愿望——`WishSummary` 里没有 status 字段，前端无法区分
 * "还在求购"与"已经不需要了"。
 */
function visibleToListingOwner(wish: WishTarget, listing: ListingTarget, score: number): boolean {
  return (
    score >= MATCH_SCORE_THRESHOLD &&
    wish.status === 'ACTIVE' &&
    listing.moderationStatus === 'APPROVED' &&
    priceWithinBudget(wish, listing)
  )
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
   * - `qualifies`（裸分达阈值 **且** 满足收窄规则）：`ON CONFLICT DO NOTHING RETURNING id` —— 真的返回了行
   *   （首次）才建通知（#2 的规则）；否则 `UPDATE` 覆盖分数（`matches.ts:9`："#8 重算时 upsert 覆盖分数"）。
   * - **不** `qualifies` 且已有行：只把分数覆盖成真实裸分，不建通知。**必须覆盖**——否则整行的旧分数
   *   仍是 ≥ 阈值，读接口就再也挡不住它（契约 §5.3 的"不删行"靠这条覆盖 + 读接口过滤成立）。
   * - **不** `qualifies` 且没有行：什么都不做（不为一个不成立的匹配新建行，也不走一次必然冲突的 INSERT）。
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
      /** 裸分达阈值 **且** 满足收窄规则（§3.1）。 */
      qualifies: boolean
      breakdown: ReturnType<typeof scoreMatch>
    },
  ): Promise<'created' | 'updated' | 'skipped'> {
    const { score, categoryScore, keywordScore, priceScore } = input.breakdown

    // 不成立又没行可写：直接跳过——否则会为一个不成立的匹配新建行**并发出通知**。
    if (!input.qualifies) {
      if (!input.hadRow) return 'skipped'
      await tx
        .update(matches)
        .set({ score, categoryScore, keywordScore, priceScore })
        .where(and(eq(matches.listingId, input.listingId), eq(matches.wishId, input.wishId)))
      return 'updated'
    }

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
      // 只有真正成立的匹配（qualifies）才走到这里，所以"插入成功"与"建了通知"是等价的。
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

    await tx
      .update(matches)
      .set({ score, categoryScore, keywordScore, priceScore })
      .where(and(eq(matches.listingId, input.listingId), eq(matches.wishId, input.wishId)))
    return 'updated'
  }

  /** 把「本轮评估集合」跑完：打分 → 写入 → 计数。 */
  async function applyTargets(
    targetListing: ListingTarget,
    targets: Map<string, { wish: WishTarget; hadRow: boolean; creatable: boolean }>,
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
      for (const { wish, hadRow, creatable: canCreate } of targets.values()) {
        const breakdown = scoreMatch(listingFacts, {
          keyword: wish.keyword,
          category: wish.category,
          budgetMaxCents: wish.budgetMaxCents,
        })
        // `qualifies` 只决定"能不能新建这一对"；计数按**读接口会不会展示**（可见性）来分。
        const qualifies = canCreate && breakdown.score >= MATCH_SCORE_THRESHOLD
        const outcome = await persist(tx, {
          listingId: targetListing.id,
          wishId: wish.id,
          wishOwnerId: wish.userId,
          hadRow,
          qualifies,
          breakdown,
        })
        if (outcome === 'skipped') continue

        // 计数用**本轮方向**的读接口可见性：applyTargets 由 `matchListing` 调用 →
        // 对应 `GET /matches?listingId=`（只展示 ACTIVE 愿望）。
        if (visibleToListingOwner(wish, targetListing, breakdown.score)) matched += 1
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
      if (listing.status !== 'ACTIVE' || listing.moderationStatus !== 'APPROVED') {
        return skipped('target-not-active')
      }

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
            status: wishes.status,
            category: wishes.category,
            budgetMaxCents: wishes.budgetMaxCents,
          })
          .from(matches)
          .innerJoin(wishes, eq(wishes.id, matches.wishId))
          .where(eq(matches.listingId, listing.id)),
      ])

      const listingTarget: ListingTarget = {
        id: listing.id,
        sellerId: listing.sellerId,
        title: listing.title,
        description: listing.description,
        priceCents: listing.priceCents,
        category: listing.category,
        status: listing.status,
        moderationStatus: listing.moderationStatus,
      }

      const existingIds = new Set(existingRows.map((row) => row.id))
      const targets = new Map<string, { wish: WishTarget; hadRow: boolean; creatable: boolean }>()
      for (const wish of candidates) {
        // 用纯函数而不是硬编码 `true`：`created <= matched` 这条不变式应当由 `creatable()` 保证，
        // 而不是"假定候选 SQL 永远与它逐条等价"（SQL 一旦放宽就会悄悄破坏它）。
        targets.set(wish.id, {
          wish,
          hadRow: existingIds.has(wish.id),
          creatable: creatable(wish, listingTarget),
        })
      }
      for (const row of existingRows) {
        // 已经掉出收窄集合（改分类、超 2 倍预算、愿望已关闭…）但行还在：也要按真实分数重新评估，
        // 并带上收窄判据（否则裸分恰好 70 的那种会被误判成有效匹配）。
        if (!targets.has(row.id)) {
          targets.set(row.id, {
            wish: row,
            hadRow: true,
            creatable: creatable(row, listingTarget),
          })
        }
      }

      return applyTargets(listingTarget, targets)
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
              eq(listings.moderationStatus, 'APPROVED'),
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
            sellerId: listings.sellerId,
            title: listings.title,
            description: listings.description,
            priceCents: listings.priceCents,
            category: listings.category,
            status: listings.status,
            moderationStatus: listings.moderationStatus,
          })
          .from(matches)
          .innerJoin(listings, eq(listings.id, matches.listingId))
          .where(eq(matches.wishId, wish.id)),
      ])

      const wishTarget: WishTarget = {
        id: wish.id,
        userId: wish.userId,
        keyword: wish.keyword,
        status: wish.status,
        category: wish.category,
        budgetMaxCents: wish.budgetMaxCents,
      }

      const existingIds = new Set(existingRows.map((row) => row.id))
      const targets = new Map<
        string,
        { listing: ListingTarget; hadRow: boolean; creatable: boolean }
      >()
      for (const listing of candidates) {
        targets.set(listing.id, {
          listing,
          hadRow: existingIds.has(listing.id),
          creatable: creatable(wishTarget, listing),
        })
      }
      for (const row of existingRows) {
        // 已下架 / 已售 / 超预算的商品不再参与匹配，但已有行仍要按真实分数覆盖并带收窄判据。
        if (!targets.has(row.id)) {
          targets.set(row.id, {
            listing: row,
            hadRow: true,
            creatable: creatable(wishTarget, row),
          })
        }
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
        for (const { listing, hadRow, creatable: canCreate } of targets.values()) {
          const breakdown = scoreMatch(
            {
              title: listing.title,
              description: listing.description,
              priceCents: listing.priceCents,
              category: listing.category,
            },
            wishFacts,
          )
          // `qualifies` 管新建；计数按 `matchWish` 对应的读接口（`/matches?wishId=`，wish 侧镜像）。
          const qualifies = canCreate && breakdown.score >= MATCH_SCORE_THRESHOLD
          const outcome = await persist(tx, {
            listingId: listing.id,
            wishId: wish.id,
            wishOwnerId: wish.userId,
            hadRow,
            qualifies,
            breakdown,
          })
          if (outcome === 'skipped') continue

          // `matchWish` → 对应 `GET /matches?wishId=`（隐藏 OFFLINE 商品，保留 RESERVED/SOLD）。
          if (visibleToWishOwner(wishTarget, listing, breakdown.score)) matched += 1
          else downgraded += 1
          if (outcome === 'created') created += 1
        }
      })

      return ok(targets.size, matched, created, downgraded)
    },
  }
}
