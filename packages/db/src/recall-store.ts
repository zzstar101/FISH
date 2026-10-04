import type { SQL } from 'drizzle-orm'
import { and, asc, desc, eq, gte, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm'
import type { Db } from './client'
import { topKSimilarListings } from './embedding-store'
import { type listingCategoryEnum, listings } from './schema/listings'
import { matches } from './schema/matches'
import { recommendationEvents } from './schema/recommendation-events'
import { users } from './schema/users'
import { wishes } from './schema/wishes'
import type { RecommendationEventType } from './user-interest-store'

/**
 * 多路召回的商品侧查询（#323 R3）。
 *
 * 本模块只做"从库里取出候选 + 算出该路的 feature"，**不做**权重选择、阈值判定、通道配额、
 * 合并去重与降级编排——那些在 `apps/api/src/modules/recommendation/recall/`。所有数值
 * （窗口长度、半衰期、每路 K、权重表）都由调用方显式传入：`packages/db` 不 import
 * `@fish/contracts`（见 `user-interest-store.ts` 的同一条约定），常量只有一处定义。
 *
 * ## 可见性是**每一路**的谓词，不是最后再筛一遍
 *
 * 每一路 SQL 都带 `visibleListingConditions()`：召回是"在可见集合里取 Top-K"，而不是
 * "全域取 Top-K 再过滤"。后者会让 SOLD / 待审 / 本人商品占掉名额，把合法候选挤出去——
 * 极端情况下语义召回 Top-100 全是已售商品，返回的候选集直接是空的。
 *
 * 最终返回前**仍要再查一次**（`findVisibleListingRefs`）：候选集是多次查询的并集，
 * 从第一次查询到最终返回之间商品可能已被卖掉/下架，快照不能当可见性真值（Issue #323 M3）。
 */

type ListingCategory = (typeof listingCategoryEnum.enumValues)[number]

/**
 * 公开可见谓词。与 `apps/api/src/modules/listings/store.ts` 的公开 Feed 一致
 * （`status='ACTIVE'` + `moderationStatus='APPROVED'`），并额外显式排除治理下架。
 *
 * 治理下架当前**一定**同时把 `status` 置为 `OFFLINE`（`governance/service.ts` 的 delist 路径），
 * 所以 `status='ACTIVE'` 已经覆盖它；这里再写一次 `governance_delisted_at IS NULL` 是纵深防御：
 * 一旦将来某条路径只打标记不改状态，"治理下架立即消失"（Issue #323 M3）不能靠一条隐式约定撑着。
 */
export function visibleListingConditions(viewerUserId: string | null): SQL[] {
  return [
    eq(listings.status, 'ACTIVE'),
    eq(listings.moderationStatus, 'APPROVED'),
    isNull(listings.governanceDelistedAt),
    ...(viewerUserId === null ? [] : [ne(listings.sellerId, viewerUserId)]),
  ]
}

/** 把谓词拼成单个 SQL（`topKSimilarListings` 的 `filter` 不接受 `undefined`）。 */
function visibleListingFilter(viewerUserId: string | null): SQL {
  return sql.join(visibleListingConditions(viewerUserId), sql` and `)
}

/* ------------------------------------------------------------------ fresh */

export type FreshRecallCandidate = { listingId: string; createdAt: Date }

/**
 * Fresh 通道：最近发布的公开商品。
 *
 * 排序用 `(created_at, id)` 而不是只按 `created_at`：同秒发布的两件商品必须有稳定顺序，
 * 否则同一份数据两次召回会给出不同候选（"同输入可复现"是 R3 的验收项）。
 */
export async function findFreshRecallCandidates(
  db: Db,
  input: { limit: number; viewerUserId: string | null },
): Promise<FreshRecallCandidate[]> {
  if (input.limit <= 0) return []

  return db
    .select({ listingId: listings.id, createdAt: listings.createdAt })
    .from(listings)
    .where(and(...visibleListingConditions(input.viewerUserId)))
    .orderBy(desc(listings.createdAt), desc(listings.id))
    .limit(input.limit)
}

/* ---------------------------------------------------------------- popular */

/**
 * 一种行为的权重（`eventType → weight` 的一项）。
 *
 * 刻意不叫 `PopularWeight`：Popular 通道用 `POPULARITY_ACTION_WEIGHTS`，Category/会话类目权重
 * 用的是 R2 的 `INTEREST_ACTION_WEIGHTS`（两套数值、两种语义），本模块只认"传进来的这张表"。
 */
export type RecallActionWeight = { eventType: RecommendationEventType; weight: number }

export type PopularRecallCandidate = { listingId: string; popularity: number }

/**
 * Popular 通道：时间衰减后的**全局**行为热度。
 *
 * ```
 * popularity(listing) = Σ_behaviors [ w(event) × 0.5^(age(occurred_at)/halflife_action) ]
 *                       × 0.5^(age(listing.created_at)/halflife_listing)
 * ```
 *
 * 两层衰减都是必须的：只有行为衰减，历史爆款靠持续的老行为就能永久占前排（Issue #323 M2
 * 明说"不能把历史爆款永久固定前排"）；只有商品年龄衰减，一件刚发布就被大量浏览的商品会与
 * 一件三个月前被同样浏览的商品同分，丢掉"最近在热"的时间信号。
 *
 * `now` 由调用方注入而不是用 SQL 的 `now()`：同一批召回里所有路的"现在"必须是同一个时刻，
 * 否则测试无法复现，跨路的 feature 也不可比。`greatest(..., 0)` 兜住客户端时钟略快导致
 * 未来时间的 `occurred_at`（R1 允许 10 分钟时钟偏差），否则负年龄会算出 > 1 的放大系数。
 *
 * 聚合在 SQL 侧完成（而不是取回事件在 JS 里算）：14 天窗口的事件量远大于候选数，
 * 回库传输的是"每件商品一行"。
 */
export async function findPopularRecallCandidates(
  db: Db,
  input: {
    limit: number
    viewerUserId: string | null
    /** 行为窗口起点（`popularityWindowStart(now)`）。 */
    windowStart: Date
    now: Date
    weights: readonly RecallActionWeight[]
    actionHalfLifeMs: number
    listingAgeHalfLifeMs: number
  },
): Promise<PopularRecallCandidate[]> {
  if (input.limit <= 0 || input.weights.length === 0) return []

  const weightCase = sql.join(
    input.weights.map(
      ({ eventType, weight }) =>
        sql`when ${recommendationEvents.eventType} = ${eventType} then ${weight}::double precision`,
    ),
    sql` `,
  )

  const ageMs = (column: SQL | ReturnType<typeof sql>) =>
    sql`greatest(extract(epoch from (${input.now}::timestamptz - ${column})) * 1000, 0)`

  const actionDecay = sql`power(0.5, ${ageMs(sql`${recommendationEvents.occurredAt}`)} / ${input.actionHalfLifeMs}::double precision)`
  const listingDecay = sql`power(0.5, ${ageMs(sql`${listings.createdAt}`)} / ${input.listingAgeHalfLifeMs}::double precision)`

  const popularity = sql`sum(case ${weightCase} else 0 end * ${actionDecay}) * ${listingDecay}`

  const rows = await db
    .select({ listingId: listings.id, popularity })
    .from(recommendationEvents)
    .innerJoin(listings, eq(listings.id, recommendationEvents.listingId))
    .where(
      and(
        gte(recommendationEvents.occurredAt, input.windowStart),
        inArray(
          recommendationEvents.eventType,
          input.weights.map(({ eventType }) => eventType),
        ),
        ...visibleListingConditions(input.viewerUserId),
      ),
    )
    .groupBy(listings.id, listings.createdAt)
    .orderBy(desc(popularity), asc(listings.id))
    .limit(input.limit)

  // PG 的 `sum()` 是 numeric，驱动回读为字符串：这里显式转数字，别让 "12" 这类字符串
  // 一路漂到排序器里（字符串比较会把 "9" 排到 "10" 前面）。
  return rows.map((row) => ({ listingId: row.listingId, popularity: Number(row.popularity) }))
}

/* --------------------------------------------------------------- semantic */

export type SemanticRecallCandidate = { listingId: string; semanticScore: number }

/**
 * Semantic 通道：用户兴趣向量 ↔ 商品向量的 cosine Top-K。
 *
 * 直接复用 #322 M2 的 `topKSimilarListings`（exact scan + `model` 过滤 + 新鲜度谓词），
 * 只把可见性谓词当 `filter` 传进去——"向量该怎么比"只有一处实现。**不**在 JS 里过滤：
 * 被 SOLD / 待审商品占掉的名额无法从结果里补回来。
 *
 * `semanticScore = 1 − distance`：距离 0（同向）得 1，正交得 0。R4 的排序要的是"越大越相关"，
 * 而 `<=>` 是距离，符号相反；在边界上转一次，免得每个消费方各转一次、迟早有一处忘转。
 */
export async function findSemanticRecallCandidates(
  db: Db,
  input: { vector: readonly number[]; model: string; limit: number; viewerUserId: string | null },
): Promise<SemanticRecallCandidate[]> {
  if (input.limit <= 0 || input.vector.length === 0) return []

  const candidates = await topKSimilarListings(db, {
    model: input.model,
    vector: [...input.vector],
    limit: input.limit,
    filter: visibleListingFilter(input.viewerUserId),
  })

  return candidates.map(({ id, distance }) => ({ listingId: id, semanticScore: 1 - distance }))
}

/* ------------------------------------------------------------------- wish */

export type WishRecallCandidate = { listingId: string; wishScore: number }

/**
 * Wish 通道：我的 ACTIVE 愿望已匹配到的商品（读 #322 落下的 `matches` 结果）。
 *
 * 不在这里实时算 pgvector：`matches` 已经是"愿望 × 商品"的匹配结论（含语义分），重算等于把
 * #322 的匹配引擎在召回路径上再实现一遍，还会给出与商品详情页不一致的结果。代价是新鲜度取决于
 * #322 匹配 job 的调度节奏（已知边界，见设计文档）。
 *
 * 同一商品被我的多个愿望命中时只保留**最高分**那一行（Issue #323 M2：同一 listing 多 Wish 命中
 * 只保留一个 candidate）：`max(score)` + 按 listing 分组，source 记 `wish`。
 */
export async function findWishRecallCandidates(
  db: Db,
  input: { userId: string; limit: number },
): Promise<WishRecallCandidate[]> {
  if (input.limit <= 0) return []

  const wishScore = sql<number>`max(${matches.score})`

  const rows = await db
    .select({ listingId: matches.listingId, wishScore })
    .from(matches)
    .innerJoin(wishes, eq(wishes.id, matches.wishId))
    .innerJoin(listings, eq(listings.id, matches.listingId))
    .where(
      and(
        eq(wishes.userId, input.userId),
        eq(wishes.status, 'ACTIVE'),
        ...visibleListingConditions(input.userId),
      ),
    )
    .groupBy(matches.listingId)
    .orderBy(desc(wishScore), asc(matches.listingId))
    .limit(input.limit)

  return rows.map((row) => ({ listingId: row.listingId, wishScore: Number(row.wishScore) }))
}

/* --------------------------------------------------------------- category */

export type CategoryRecallCandidate = { listingId: string; category: ListingCategory }

/**
 * Category 通道：按会话内类目兴趣取候选，是 semantic 不可用时的重要兜底（纯 SQL、无需向量）。
 *
 * 每个类目**单独一条查询**，而不是一条带窗口函数的查询：类目最多 3 个、每个类目各自
 * `ORDER BY created_at DESC LIMIT perCategory`，能直接吃到 `(category, ...)` 索引，SQL 也短得多。
 * 返回顺序 = 传入的 `categories` 顺序（已按兴趣权重降序），同权重内按发布时间降序。
 */
export async function findCategoryRecallCandidates(
  db: Db,
  input: {
    /** 已按兴趣权重降序的类目（最多 `RECALL_SESSION_CATEGORY_TOP_N` 个）。 */
    categories: readonly ListingCategory[]
    /** 单类目上限。 */
    perCategoryLimit: number
    viewerUserId: string | null
  },
): Promise<CategoryRecallCandidate[]> {
  if (input.perCategoryLimit <= 0 || input.categories.length === 0) return []

  const pages = await Promise.all(
    input.categories.map((category) =>
      db
        .select({ listingId: listings.id, category: listings.category })
        .from(listings)
        .where(
          and(eq(listings.category, category), ...visibleListingConditions(input.viewerUserId)),
        )
        .orderBy(desc(listings.createdAt), desc(listings.id))
        .limit(input.perCategoryLimit),
    ),
  )

  return pages.flat()
}

/* ---------------------------------------------------------------- explore */

/**
 * 探索子来源。**内部标记，不是契约枚举值**（Issue #323 M2 只要求"给小比例探索流量"，
 * 没有要求把探索动机写进 `source`）：新增枚举值要动契约 + 迁移，而子来源是 R3/R4 的调参维度，
 * 变动频率远高于对外归因标签。对外一律记 `explore`。
 */
export type ExploreSubSource = 'new_listing' | 'new_seller' | 'cold_category'

export type ExploreRecallCandidate = { listingId: string; subSource: ExploreSubSource }

/**
 * Exploration 通道：新商品 / 新卖家 / 用户没接触过的类目。
 *
 * 三个子块各自的窗口与配额由调用方传入（`RECALL_EXPLORE_MIX`）。去重顺序即优先级
 * （新商品 > 新卖家 > 冷门类目），**去重后不足的名额让给新商品**（Issue #323 M2 的
 * "不足让位"）：一件商品同时是新商品和新卖家的商品只应出现一次，但"探索位没填满"
 * 不该白白空着——它正是新商品最需要的曝光。
 */
export async function findExploreRecallCandidates(
  db: Db,
  input: {
    limit: number
    newListingLimit: number
    newSellerLimit: number
    coldCategoryLimit: number
    newListingWindowStart: Date
    newSellerWindowStart: Date
    /** 会话内未出现过的类目（由 api 侧算，db 不知道会话）。 */
    coldCategories: readonly ListingCategory[]
    viewerUserId: string | null
  },
): Promise<ExploreRecallCandidate[]> {
  if (input.limit <= 0) return []

  const visible = visibleListingConditions(input.viewerUserId)

  // 新商品多取一些（上限 = 整个探索预算）：去重后若有空位，用它来补。
  const [newListings, newSellers, coldCategories] = await Promise.all([
    input.newListingLimit <= 0
      ? Promise.resolve([])
      : db
          .select({ listingId: listings.id })
          .from(listings)
          .where(and(gte(listings.createdAt, input.newListingWindowStart), ...visible))
          .orderBy(desc(listings.createdAt), desc(listings.id))
          .limit(input.limit),
    input.newSellerLimit <= 0
      ? Promise.resolve([])
      : db
          .select({ listingId: listings.id })
          .from(listings)
          .innerJoin(users, eq(users.id, listings.sellerId))
          .where(and(gte(users.createdAt, input.newSellerWindowStart), ...visible))
          .orderBy(desc(listings.createdAt), desc(listings.id))
          .limit(input.newSellerLimit),
    input.coldCategoryLimit <= 0 || input.coldCategories.length === 0
      ? Promise.resolve([])
      : db
          .select({ listingId: listings.id })
          .from(listings)
          .where(and(inArray(listings.category, [...input.coldCategories]), ...visible))
          .orderBy(desc(listings.createdAt), desc(listings.id))
          .limit(input.coldCategoryLimit),
  ])

  const taken = new Set<string>()
  const picked: ExploreRecallCandidate[] = []

  const take = (
    rows: readonly { listingId: string }[],
    subSource: ExploreSubSource,
    quota: number,
  ) => {
    let used = 0
    for (const row of rows) {
      if (used >= quota) return
      if (taken.has(row.listingId)) continue
      taken.add(row.listingId)
      picked.push({ listingId: row.listingId, subSource })
      used += 1
    }
  }

  take(newListings, 'new_listing', input.newListingLimit)
  take(newSellers, 'new_seller', input.newSellerLimit)
  take(coldCategories, 'cold_category', input.coldCategoryLimit)

  // 空位补新商品：`newListings` 上一步只用了前 `newListingLimit` 条，后面还有。
  for (const row of newListings) {
    if (picked.length >= input.limit) break
    if (taken.has(row.listingId)) continue
    taken.add(row.listingId)
    picked.push({ listingId: row.listingId, subSource: 'new_listing' })
  }

  return picked.slice(0, input.limit)
}

/* --------------------------------------------------------------- 合并前后 */

export type VisibleListingRef = {
  listingId: string
  sellerId: string
  category: ListingCategory
  createdAt: Date
}

/**
 * 合并去重后的**最终可见性复核**：返回候选里当前仍然可见的商品 + 卖家 + 类目 + 发布时间。
 *
 * 三件事必须在这里一起做：
 * 1. 可见性是"此刻"的真值。候选集由多次查询拼成，第一次查询之后商品可能已被买走、被审核
 *    阻断、被治理下架——召回快照不能当最终真值（Issue #323 M3）。
 * 2. `sellerExposure`（同卖家在本次候选集内的数量）要卖家 id 才能算。
 * 3. `userCategoryAffinity` 与 `freshness` 需要类目与 `created_at`——它们对**所有**通道的候选
 *    都要算（不只 Category/Fresh 通道的），所以只能从这次复核里拿：合并层不该为了两个 feature
 *    再为每个 listingId 发一次查询，也不该信任召回快照里的旧值。
 */
export async function findVisibleListingRefs(
  db: Db,
  input: { listingIds: readonly string[]; viewerUserId: string | null },
): Promise<VisibleListingRef[]> {
  if (input.listingIds.length === 0) return []

  return db
    .select({
      listingId: listings.id,
      sellerId: listings.sellerId,
      category: listings.category,
      createdAt: listings.createdAt,
    })
    .from(listings)
    .where(
      and(
        inArray(listings.id, [...input.listingIds]),
        ...visibleListingConditions(input.viewerUserId),
      ),
    )
}

/* ------------------------------------------------- category / explore 输入 */

/** 会话行为窗落到的类目及其衰减权重（Category 通道 + Explore 的"冷门类目"共用）。 */
export type SessionCategoryWeight = {
  category: ListingCategory
  /** Σ(动作权重 × 时间衰减)；负向动作让它可以为负。 */
  weight: number
}

/**
 * 会话行为窗内的**类目权重分布**（Issue #323 M2 的 Category 通道 + M2 的 Exploration "冷门类目"）。
 *
 * 与 R2 的 `loadUserInterestActions` 是同一个窗口（同一身份谓词、同一 `since`、同一 `limit`、
 * 同一零权事件排除），只是聚合维度不同：R2 要的是"每个行为的 listing 向量"，这里要的是"按类目
 * 汇总的权重"。**不能复用它的返回**：`LoadedInterestAction` 刻意不暴露 `listingId`（那是画像聚合
 * 不需要、暴露了会诱导调用方按商品聚合），这里必须 join `listings` 才能拿到类目，所以窗口谓词
 * 在本文件里重写一遍——两边一旦漂移，"会话兴趣"与"会话类目"就会描述同一个用户的两个不同过去。
 * 修改任一侧时另一侧必须同步。
 *
 * `limit` 生效在**子查询里**（时间窗内最近的 N 条），不是聚合后：先聚合再截断会把"最近 50 条行为"
 * 变成"权重最高的 50 个类目"，与 R2 的会话口径不再等价。
 */
export async function findSessionCategoryWeights(
  db: Db,
  input: {
    identity: { kind: 'user'; id: string } | { kind: 'anonymous'; id: string }
    since: Date
    now: Date
    limit: number
    /** 不计入权重的行为类型（R2 的 `INTEREST_ZERO_WEIGHT_EVENT_TYPES`）。 */
    zeroWeightEventTypes: readonly RecommendationEventType[]
    /** 计入权重的行为类型及其权重；未列出的类型权重为 0。 */
    weights: readonly RecallActionWeight[]
    halfLifeMs: number
  },
): Promise<SessionCategoryWeight[]> {
  const identityFilter =
    input.identity.kind === 'user'
      ? eq(recommendationEvents.userId, input.identity.id)
      : and(
          eq(recommendationEvents.anonymousSessionId, input.identity.id),
          isNull(recommendationEvents.userId),
        )

  const windowQuery = db
    .select({
      listingId: recommendationEvents.listingId,
      eventType: recommendationEvents.eventType,
      occurredAt: recommendationEvents.occurredAt,
    })
    .from(recommendationEvents)
    .where(
      and(
        identityFilter,
        gte(recommendationEvents.occurredAt, input.since),
        notInArray(recommendationEvents.eventType, [...input.zeroWeightEventTypes]),
      ),
    )
    .orderBy(desc(recommendationEvents.occurredAt), asc(recommendationEvents.id))
    .limit(input.limit)
    .as('interest_window')

  const decayExpression = sql`power(0.5, greatest(extract(epoch from (${input.now}::timestamptz - ${windowQuery.occurredAt})) * 1000, 0) / ${input.halfLifeMs})`
  const weightExpression = sql`case ${sql.join(
    input.weights.map(
      (entry) => sql`when ${windowQuery.eventType} = ${entry.eventType} then ${entry.weight}`,
    ),
    sql` `,
  )} else 0 end`

  const rows = await db
    .select({
      category: listings.category,
      weight: sql<number>`sum((${weightExpression}) * ${decayExpression})`,
    })
    .from(windowQuery)
    .innerJoin(listings, eq(listings.id, windowQuery.listingId))
    .groupBy(listings.category)

  return rows.map((row) => ({
    category: row.category,
    weight: Number(row.weight),
  }))
}

/**
 * 某个身份对这批商品的**历史曝光次数**（M3 的 `alreadySeenCount`）。
 *
 * 不加时间窗：重复曝光的惩罚关心的是"这件事已经发生过多少次"，用窗口截断会让同一件商品
 * 在被反复曝光 30 天后重新变得"没看过"。事件本身有 180 天保留期（R6 的清理任务），
 * 天然有上界。
 *
 * 匿名分支与 R2 的 `loadUserInterestActions` 用同一条谓词（会话 id 匹配 **且** `user_id IS NULL`）：
 * 同一台设备的匿名会话 id 在登录后仍会随事件上报，不排掉就等于拿登录后的行为算匿名身份。
 */
export async function countListingImpressions(
  db: Db,
  input: {
    listingIds: readonly string[]
    identity: { kind: 'user'; id: string } | { kind: 'anonymous'; id: string }
  },
): Promise<{ listingId: string; count: number }[]> {
  if (input.listingIds.length === 0) return []

  const identityFilter =
    input.identity.kind === 'user'
      ? eq(recommendationEvents.userId, input.identity.id)
      : and(
          eq(recommendationEvents.anonymousSessionId, input.identity.id),
          isNull(recommendationEvents.userId),
        )

  const rows = await db
    .select({
      listingId: recommendationEvents.listingId,
      count: sql<number>`count(*)::int`,
    })
    .from(recommendationEvents)
    .where(
      and(
        identityFilter,
        eq(recommendationEvents.eventType, 'IMPRESSION'),
        inArray(recommendationEvents.listingId, [...input.listingIds]),
      ),
    )
    .groupBy(recommendationEvents.listingId)

  return rows.map((row) => ({ listingId: row.listingId, count: Number(row.count) }))
}

export type ExposureHistory = {
  listingId: string
  /** 归因曝光（`IMPRESSION`）次数。 */
  exposureCount: number
  /** 最后一次归因曝光时间；一次都没曝光过时为 `null`。 */
  lastExposedAt: Date | null
  /** 归因互动（`engagementEventTypes`）次数。 */
  engagedCount: number
}

/**
 * 某个身份对这批商品的**曝光与互动历史聚合**（#323 M6 重复曝光冷却的输入）。
 *
 * 与 `countListingImpressions` 的三点一致、一点不同：
 *
 * - **一致**：身份谓词（匿名分支必须 `user_id IS NULL`）、同族放在本文件、`inArray(listingId)`
 *   限定候选集（冷却只可能作用在本次候选上，没必要把全部历史捞回来）。
 * - **不同**：`countListingImpressions` 只数曝光，这里一次查回三个聚合 —— 曝光次数、"最后一次
 *   曝光"（冷却从它起算）、互动次数（有互动就解除冷却）。三次查询换成一条 `filter` 聚合，冷却
 *   的判据才可能在一个时间点上自洽（见 `cooldownListingIds`）。
 *
 * 不加时间窗：与 `countListingImpressions` 同理，"反复曝光"没有自然下界，事件本身有 180 天保留
 * 期。`engagementEventTypes` 由调用方给出（本包**不依赖 contracts**，与
 * `findNegativeFeedbackEvents` 的 `eventTypes` 同法），**不得包含 `IMPRESSION`** —— 互动次数用
 * `event_type <> 'IMPRESSION'` 统计。
 */
export async function findExposureHistory(
  db: Db,
  input: {
    listingIds: readonly string[]
    identity: { kind: 'user'; id: string } | { kind: 'anonymous'; id: string }
    /** 解除冷却的互动事件类型（不含 `IMPRESSION`）。 */
    engagementEventTypes: readonly RecommendationEventType[]
  },
): Promise<ExposureHistory[]> {
  if (input.listingIds.length === 0) return []

  const identityFilter =
    input.identity.kind === 'user'
      ? eq(recommendationEvents.userId, input.identity.id)
      : and(
          eq(recommendationEvents.anonymousSessionId, input.identity.id),
          isNull(recommendationEvents.userId),
        )

  const rows = await db
    .select({
      listingId: recommendationEvents.listingId,
      exposureCount: sql<number>`count(*) filter (where ${recommendationEvents.eventType} = 'IMPRESSION')::int`,
      lastExposedAt: sql<Date | null>`max(${recommendationEvents.occurredAt}) filter (where ${recommendationEvents.eventType} = 'IMPRESSION')`,
      engagedCount: sql<number>`count(*) filter (where ${recommendationEvents.eventType} <> 'IMPRESSION')::int`,
    })
    .from(recommendationEvents)
    .where(
      and(
        identityFilter,
        inArray(recommendationEvents.listingId, [...input.listingIds]),
        inArray(recommendationEvents.eventType, [
          'IMPRESSION',
          ...new Set(input.engagementEventTypes),
        ]),
      ),
    )
    .groupBy(recommendationEvents.listingId)

  return rows.map((row) => ({
    listingId: row.listingId,
    exposureCount: Number(row.exposureCount),
    lastExposedAt: row.lastExposedAt === null ? null : new Date(row.lastExposedAt),
    engagedCount: Number(row.engagedCount),
  }))
}

/* ------------------------------------------------------- negative feedback */

export type NegativeFeedbackEvent = {
  listingId: string
  category: ListingCategory
  sellerId: string
  eventType: RecommendationEventType
  occurredAt: Date
}

/**
 * 某身份在时间窗内的**负反馈原始事件**（#323 R4 的 `negativeFeedbackPenalty` 输入）。
 *
 * 返回原始行而不是聚合值：负反馈有**两个作用面**——listing 级硬排除（"这件我不要了"）与
 * 类目/卖家级软惩罚（"这类/这家我不想看了"）——同一条事件同时贡献两者。聚合在这里做掉任一个，
 * 调用方就得再查一次才能拿到另一个。
 *
 * 与 `countListingImpressions` 的三点一致与一点不同：
 *
 * - **一致**：身份谓词（匿名分支必须 `user_id IS NULL`）、不加商品白名单（负反馈是"这个人讨厌
 *   什么"，不可能由候选集反推）、放在本文件（与召回/排序喂候选级统计的查询同族）。
 * - **不同**：**带时间窗**（`since`）。曝光次数关心"累计发生过多少次"，负反馈关心"现在还讨厌吗"，
 *   所以用 R2 长期画像的口径（180 天窗 + 14 天半衰期）。衰减**不在本层做**：它是纯计算，
 *   放契约层才能离线 fixture 回放（`RANK_NEGATIVE_FEEDBACK_WEIGHTS` + `INTEREST_HALF_LIFE_MS`）。
 *
 * `innerJoin listings` 取类目与卖家：`recommendation_events.listing_id` 是 `ON DELETE CASCADE`，
 * 商品被删时事件本身也没了，所以不会出现孤儿事件、不会丢行。
 * 索引 `recommendation_events_{user_id,session_id}_occurred_at_idx` 已覆盖该谓词，不另加索引。
 */
export async function findNegativeFeedbackEvents(
  db: Db,
  input: {
    identity: { kind: 'user'; id: string } | { kind: 'anonymous'; id: string }
    since: Date
    /** 触发负反馈的事件类型（权重与硬排除口径由调用方决定）。 */
    eventTypes: readonly RecommendationEventType[]
  },
): Promise<NegativeFeedbackEvent[]> {
  if (input.eventTypes.length === 0) return []

  const identityFilter =
    input.identity.kind === 'user'
      ? eq(recommendationEvents.userId, input.identity.id)
      : and(
          eq(recommendationEvents.anonymousSessionId, input.identity.id),
          isNull(recommendationEvents.userId),
        )

  const rows = await db
    .select({
      listingId: recommendationEvents.listingId,
      eventType: recommendationEvents.eventType,
      occurredAt: recommendationEvents.occurredAt,
      category: listings.category,
      sellerId: listings.sellerId,
    })
    .from(recommendationEvents)
    .innerJoin(listings, eq(listings.id, recommendationEvents.listingId))
    .where(
      and(
        identityFilter,
        gte(recommendationEvents.occurredAt, input.since),
        inArray(recommendationEvents.eventType, [...input.eventTypes]),
      ),
    )

  return rows.map((row) => ({
    listingId: row.listingId,
    category: row.category,
    sellerId: row.sellerId,
    eventType: row.eventType,
    occurredAt: row.occurredAt,
  }))
}
