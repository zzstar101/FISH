import {
  buildListingEmbeddingText,
  buildWishEmbeddingText,
  contentHashOf,
} from '@fish/contracts/embedding/text'
import type { ListingCategory, ListingStatus } from '@fish/contracts/listings/schema'
import { MATCH_SCORE_THRESHOLD, MATCH_SEMANTIC_TOP_K } from '@fish/contracts/matching/schema'
import type { Db } from '@fish/db/client'
import {
  type EmbeddingEntity,
  findEmbedding,
  hasEmbeddingFromOtherModel,
  similarListingsByIds,
  similarWishesByIds,
  topKSimilarListings,
  topKSimilarWishes,
} from '@fish/db/embedding-store'
import { jsonParam } from '@fish/db/json'
import { EMBEDDING_DIMENSIONS } from '@fish/db/schema/embeddings'
import { listings } from '@fish/db/schema/listings'
import { matches } from '@fish/db/schema/matches'
import { notifications } from '@fish/db/schema/notifications'
import { wishes } from '@fish/db/schema/wishes'
import { and, eq, inArray, ne, type SQL, sql } from 'drizzle-orm'
import { enqueueEmbedJob } from '../embedding/enqueue'
import { type MatchListingFacts, scoreMatch } from './scoring'

/**
 * Match Engine（Issue #8 契约评论 §3；#322 M2 起先做语义召回）。
 *
 * 一次运行 = 「候选召回（结构化收窄 → 向量 Top-K，或退化时用 v1 全量收窄）→ 打分（纯函数）
 * → 对齐 `matches`（幂等）」。
 * 两个方向共用同一套打分、召回与写入逻辑，只有"谁是候选"和"通知发给谁"不同。
 *
 * **"对齐"而不是"只补新行"**：召回集合之外，该目标**已有匹配行**的那几对也要重新评估。
 * 否则商品被编辑（改分类/改价/改标题）或愿望被关闭后，旧行会永远停在旧分数上，
 * 而读接口按阈值过滤也就挡不住它（只加过滤是不够的）。
 * 这条在 M2 里更重要：掉出 Top-K 的旧匹配必须被降级，而不是因为"不再被召回"就冻在旧高分上。
 *
 * **向量未就绪时不做等待**（#322 M1 交给 M2 的前置，见 M2 设计文档 §5）：目标实体缺本模型的向量
 * / 向量与当前内容不一致 / 只有旧模型的向量时，本轮退回 v1 的结构化全量候选（含已有行），
 * 并补投一条 `EMBED_*` job；候选侧没有向量只是"进不了 Top-K"，不额外投递、也不会产生伪匹配。
 *
 * **打分是 v2 hybrid，但语义分按对判定**（#322 M3，见 `scoring.ts`）：本模块的职责只是把
 * "这一对现在多少 cosine"凑齐并交给纯函数——Top-K 候选取 `<=>` 距离，**union 进来的已有行**
 * 单独按 id 精确补算（它们不在 Top-K 里，拿不到距离就会退化成 v1 分，看起来像"召回状态变了
 * 所以质量变差"）。拿不到相似度的对（目标向量不可用，或候选侧没有向量）传 `null` 给
 * `scoreMatch`，那一行按 v1 算：`semantic_score = NULL`、`ranking_version = 1`。
 *
 * 只读 `listings` / `wishes` / `embeddings`，只写 `matches` / `notifications` / 补投 `jobs`：
 * RESERVED / SOLD 的状态由交易域负责（#11），本模块不改商品状态。
 */

/** 目标行不存在 / 不再是可匹配状态时的原因；正常跑完为 `null`。 */
export type MatchSkipReason = 'target-missing' | 'target-not-active'

/** 本轮候选是怎么来的：向量 Top-K，或退化回 v1 的结构化全量收窄。 */
export type MatchRecall = 'vector-topk' | 'v1-fallback'

/**
 * 为什么没能用向量召回（`recall === 'v1-fallback'` 时必有一个）。
 *
 * - `missing`：该实体没有本模型的向量（从没生成过，或生成失败后一直没有补投成功）；
 * - `stale`：有本模型的向量，但维度不符或 `content_hash` 与当前内容不一致（内容改过还没重算）；
 * - `model-mismatch`：只有**别的模型**的向量（换了 `EMBEDDING_MODEL` 但还没 backfill）。
 *
 * 三者对召回都是"不可用"，但成因不同：前两者由 EMBED_* job 补，后者要 M4 的重建流程。
 */
export type MatchFallbackReason = 'missing' | 'stale' | 'model-mismatch'

/** 本轮的召回结果（`MatchRunResult` 的三个可观测字段，也是 M4 指标的雏形）。 */
type RecallOutcome = {
  recall: MatchRecall | null
  fallbackReason: MatchFallbackReason | null
  vectorCandidates: number
}

export type MatchRunResult = {
  /** 本轮**重新评估**过的对数：召回候选 ∪ 已有匹配行，去重后。 */
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
  /** 本轮的候选召回方式；`null` = 没跑召回（目标缺失/不可匹配，此时 `skipped !== null`）。 */
  recall: MatchRecall | null
  /** `recall === 'v1-fallback'` 时退化的原因；向量召回成功时为 `null`。 */
  fallbackReason: MatchFallbackReason | null
  /** 向量召回收到的候选条数（退化时为 0）。 */
  vectorCandidates: number
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
  /** #322 M3：`false` 时语义不能单独成立（门禁在 `scoring.ts`）。 */
  acceptSimilar: boolean
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
  recall: RecallOutcome,
): MatchRunResult => ({ evaluated, matched, created, downgraded, skipped: null, ...recall })

const skipped = (reason: MatchSkipReason): MatchRunResult => ({
  evaluated: 0,
  matched: 0,
  created: 0,
  downgraded: 0,
  skipped: reason,
  recall: null,
  fallbackReason: null,
  vectorCandidates: 0,
})

/**
 * 打分与收窄只需要这几个字段，所以"召回候选"与"已有匹配行"都投影成同一形状。
 *
 * 两处都复用同一个投影（而不是一处 `.select()` 全列、一处手写字段）：召回只返回 id，需要按 id
 * 回表取打分字段，若两处投影不一致，"Top-K 拿到的候选"与"已有行"就会是两种形状。
 */
const WISH_COLUMNS = {
  id: wishes.id,
  userId: wishes.userId,
  keyword: wishes.keyword,
  status: wishes.status,
  category: wishes.category,
  budgetMaxCents: wishes.budgetMaxCents,
  acceptSimilar: wishes.acceptSimilar,
}

const LISTING_COLUMNS = {
  id: listings.id,
  sellerId: listings.sellerId,
  title: listings.title,
  description: listings.description,
  priceCents: listings.priceCents,
  category: listings.category,
  status: listings.status,
  moderationStatus: listings.moderationStatus,
}

/*
 * 结构化收窄的两个方向（v1 起就没变；M2 起**同一份条件**既喂给向量 Top-K 查询、也喂给退化时的
 * 全量查询）：
 *
 * - 分类：`wish.category IS NULL`（不限分类）时放行全部；
 * - 价格：`price <= 2 × budget_max`。这是一条**产品规则**，不只是性能优化：超过 2 倍预算的候选
 *   **不参与匹配**，即使它分类与关键词都满分（那种情况总分恰好 70，本可以过阈值）。
 *   界限与 `scoring.ts` 里 `priceScore` 归零的位置相同，但不能读成"只排除 priceScore = 0 的候选"。
 *   用 `::bigint` 是因为 `integer` 列上 `2 * max` 会溢出（PG 22003 直接 500）。
 *
 * ⚠️ 向量召回**必须**把它作为 Top-K 查询的 WHERE，而不是先全域取 Top-K 再过滤：否则被价格/
 * 分类/状态挡掉的候选会挤占 K 个名额，合法候选掉出召回——"结构化规则继续做硬约束"就不成立了。
 */
function narrowedWishes(listing: ListingTarget): SQL | undefined {
  return and(
    eq(wishes.status, 'ACTIVE'),
    // 自己的愿望不吃自己的商品。
    ne(wishes.userId, listing.sellerId),
    sql`(${wishes.category} IS NULL OR ${wishes.category} = ${listing.category})`,
    sql`(${wishes.budgetMaxCents} IS NULL OR ${listing.priceCents}::bigint <= 2::bigint * ${wishes.budgetMaxCents})`,
  )
}

function narrowedListings(wish: WishTarget): SQL | undefined {
  return and(
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
  )
}

/** 本进程使用的 embedding 模型名由 worker 在装配时给出（`provider.model`）。 */
export type MatchEngineOptions = {
  embeddingModel: string
}

export function createMatchEngine(db: Db, options: MatchEngineOptions): MatchEngine {
  const { embeddingModel } = options
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
    const { score, categoryScore, keywordScore, priceScore, semanticScore, rankingVersion } =
      input.breakdown

    // 不成立又没行可写：直接跳过——否则会为一个不成立的匹配新建行**并发出通知**。
    if (!input.qualifies) {
      if (!input.hadRow) return 'skipped'
      await tx
        .update(matches)
        .set({ score, categoryScore, keywordScore, priceScore, semanticScore, rankingVersion })
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
        semanticScore,
        rankingVersion,
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
      .set({ score, categoryScore, keywordScore, priceScore, semanticScore, rankingVersion })
      .where(and(eq(matches.listingId, input.listingId), eq(matches.wishId, input.wishId)))
    return 'updated'
  }

  /**
   * 判断目标实体的向量能不能用来召回。
   *
   * "新鲜"的判据 = `model`（查询已带）+ `dimensions` + **`content_hash` 等于当前内容重算的指纹**。
   * 只判"有没有行"会把过期向量当最新用：EMBED job 在 provider 网络调用期间实体被编辑时，写进去的
   * 是旧内容的向量（#322 验收："stale embedding 不能被当新内容继续匹配"）。反过来，内容改了又改
   * 回来时指纹相同——那份向量确实对应当前内容，不需要重算。
   *
   * 三种退化原因都退回 v1 召回（见 `matchListing` / `matchWish`），并补投 EMBED_* job。
   */
  async function loadTargetVector(
    entity: EmbeddingEntity,
    text: string,
  ): Promise<
    { status: 'ready'; embedding: number[] } | { status: 'fallback'; reason: MatchFallbackReason }
  > {
    const row = await findEmbedding(db, entity, embeddingModel)
    if (row === null) {
      // 没有本模型的向量：可能是从没生成过，也可能只有旧模型的（换模型后未 backfill）。
      const otherModel = await hasEmbeddingFromOtherModel(db, entity, embeddingModel)
      return { status: 'fallback', reason: otherModel ? 'model-mismatch' : 'missing' }
    }
    if (row.dimensions !== EMBEDDING_DIMENSIONS || row.contentHash !== contentHashOf(text)) {
      return { status: 'fallback', reason: 'stale' }
    }
    return { status: 'ready', embedding: row.embedding }
  }

  /**
   * 把「本轮评估集合」跑完：打分 → 写入 → 计数。
   *
   * `similarities`：候选 id → 原始 cosine（`1 - pgvector 距离`）。**没有条目 = 这一对拿不到
   * 语义分**（目标向量不可用，或候选侧没有向量），该对按 v1 打分——与"语义分恰好是 0"区分开：
   * 前者 `semantic_score = NULL` / `ranking_version = 1`，后者是 v2 算出的真实 0 分。
   */
  async function applyTargets(
    targetListing: ListingTarget,
    targets: Map<string, { wish: WishTarget; hadRow: boolean; creatable: boolean }>,
    recall: RecallOutcome,
    similarities: Map<string, number>,
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
        const similarity = similarities.get(wish.id)
        const breakdown = scoreMatch(
          listingFacts,
          {
            keyword: wish.keyword,
            category: wish.category,
            budgetMaxCents: wish.budgetMaxCents,
            acceptSimilar: wish.acceptSimilar,
          },
          // 拿不到 cosine 的对走 v1 分支（`semantic_score = NULL`、`ranking_version = 1`）。
          similarity === undefined ? null : { similarity },
        )
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

    return ok(targets.size, matched, created, downgraded, recall)
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

      // 已有行与候选召回互不依赖：先发查询，下面只 await（省一次串行往返）。
      const existingRowsPromise = db
        .select(WISH_COLUMNS)
        .from(matches)
        .innerJoin(wishes, eq(wishes.id, matches.wishId))
        .where(eq(matches.listingId, listing.id))

      const narrowing = narrowedWishes(listingTarget)
      const targetVector = await loadTargetVector(
        { kind: 'listing', id: listing.id },
        buildListingEmbeddingText({
          title: listing.title,
          description: listing.description,
          category: listing.category,
        }),
      )

      let candidates: WishTarget[]
      let recall: MatchRecall
      let fallbackReason: MatchFallbackReason | null = null
      let vectorCandidates = 0
      /** 候选 id → 原始 cosine（`1 - 距离`）；只放"真的算得出相似度"的那些对。 */
      const similarities = new Map<string, number>()

      if (targetVector.status === 'ready') {
        const similar = await topKSimilarWishes(db, {
          model: embeddingModel,
          vector: targetVector.embedding,
          limit: MATCH_SEMANTIC_TOP_K,
          filter: narrowing,
        })
        vectorCandidates = similar.length
        for (const row of similar) similarities.set(row.id, 1 - row.distance)
        const ids = similar.map((row) => row.id)
        // 空集合直接跳过回表（`inArray(col, [])` 会生成恒假条件，但没必要发这次查询）。
        candidates =
          ids.length === 0
            ? []
            : await db.select(WISH_COLUMNS).from(wishes).where(inArray(wishes.id, ids))
        recall = 'vector-topk'
      } else {
        // 退化：本轮退回 v1 的结构化全量候选，同时补投一条 EMBED_* job（下次运行就能用上向量）。
        candidates = await db.select(WISH_COLUMNS).from(wishes).where(narrowing)
        recall = 'v1-fallback'
        fallbackReason = targetVector.reason
        await enqueueEmbedJob(db, { kind: 'listing', id: listing.id })
      }

      const existingRows = await existingRowsPromise

      /*
       * union 进来的已有行**不在 Top-K 里**，上面那轮 `<=>` 不会给它们距离：不补算的话这些对
       * 只能按 v1 打分，于是"某对掉出 Top-K"会被算成"分数变低"（假降级），同一对在两种召回
       * 状态下出现两套分数。按 id 精确补一次（行数 = 该商品的已有匹配数，个位到几十）。
       */
      if (targetVector.status === 'ready') {
        const missing = existingRows.map((row) => row.id).filter((id) => !similarities.has(id))
        const extra = await similarWishesByIds(db, {
          model: embeddingModel,
          vector: targetVector.embedding,
          ids: missing,
        })
        for (const row of extra) similarities.set(row.id, 1 - row.distance)
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

      return applyTargets(
        listingTarget,
        targets,
        { recall, fallbackReason, vectorCandidates },
        similarities,
      )
    },

    async matchWish(wishId) {
      const wish = (await db.select().from(wishes).where(eq(wishes.id, wishId)).limit(1))[0]
      if (!wish) return skipped('target-missing')
      // 已关闭 / 已满足的愿望不再拉新匹配（与愿望池只统计 ACTIVE 同一取向）。
      if (wish.status !== 'ACTIVE') return skipped('target-not-active')

      const wishTarget: WishTarget = {
        id: wish.id,
        userId: wish.userId,
        keyword: wish.keyword,
        status: wish.status,
        category: wish.category,
        budgetMaxCents: wish.budgetMaxCents,
        acceptSimilar: wish.acceptSimilar,
      }

      // 与 listing 方向同构：已有行与召回并发发出，取回顺序不影响结果。
      const existingRowsPromise = db
        .select(LISTING_COLUMNS)
        .from(matches)
        .innerJoin(listings, eq(listings.id, matches.listingId))
        .where(eq(matches.wishId, wish.id))

      const narrowing = narrowedListings(wishTarget)
      const targetVector = await loadTargetVector(
        { kind: 'wish', id: wish.id },
        buildWishEmbeddingText({
          keyword: wish.keyword,
          description: wish.description,
          category: wish.category,
        }),
      )

      let candidates: ListingTarget[]
      let recall: MatchRecall
      let fallbackReason: MatchFallbackReason | null = null
      let vectorCandidates = 0
      /** 候选 id → 原始 cosine（`1 - 距离`），与 listing 方向同一口径。 */
      const similarities = new Map<string, number>()

      if (targetVector.status === 'ready') {
        const similar = await topKSimilarListings(db, {
          model: embeddingModel,
          vector: targetVector.embedding,
          limit: MATCH_SEMANTIC_TOP_K,
          filter: narrowing,
        })
        vectorCandidates = similar.length
        for (const row of similar) similarities.set(row.id, 1 - row.distance)
        const ids = similar.map((row) => row.id)
        candidates =
          ids.length === 0
            ? []
            : await db.select(LISTING_COLUMNS).from(listings).where(inArray(listings.id, ids))
        recall = 'vector-topk'
      } else {
        candidates = await db.select(LISTING_COLUMNS).from(listings).where(narrowing)
        recall = 'v1-fallback'
        fallbackReason = targetVector.reason
        await enqueueEmbedJob(db, { kind: 'wish', id: wish.id })
      }

      const existingRows = await existingRowsPromise

      // 与 listing 方向同构：union 进来的已有行不在 Top-K 里，按 id 精确补算相似度。
      if (targetVector.status === 'ready') {
        const missing = existingRows.map((row) => row.id).filter((id) => !similarities.has(id))
        const extra = await similarListingsByIds(db, {
          model: embeddingModel,
          vector: targetVector.embedding,
          ids: missing,
        })
        for (const row of extra) similarities.set(row.id, 1 - row.distance)
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
        acceptSimilar: wish.acceptSimilar,
      }

      let matched = 0
      let created = 0
      let downgraded = 0

      await db.transaction(async (tx) => {
        for (const { listing, hadRow, creatable: canCreate } of targets.values()) {
          const similarity = similarities.get(listing.id)
          const breakdown = scoreMatch(
            {
              title: listing.title,
              description: listing.description,
              priceCents: listing.priceCents,
              category: listing.category,
            },
            wishFacts,
            // 拿不到 cosine 的对走 v1 分支（该商品没有本模型的向量）。
            similarity === undefined ? null : { similarity },
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

      return ok(targets.size, matched, created, downgraded, {
        recall,
        fallbackReason,
        vectorCandidates,
      })
    },
  }
}
