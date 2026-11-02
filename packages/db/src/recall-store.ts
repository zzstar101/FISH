import type { SQL } from 'drizzle-orm'
import { and, asc, desc, eq, gte, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm'
import type { Db } from './client'
import { topKSimilarListings } from './embedding-store'
import { favorites } from './schema/favorites'
import { type listingCategoryEnum, listings } from './schema/listings'
import { matches } from './schema/matches'
import { recommendationEvents } from './schema/recommendation-events'
import { recommendationRequestItems } from './schema/recommendation-request-items'
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
 * 热度（Popular 通道 + 排序的 `popularity` feature）：时间衰减后的**按身份去重**全局热度（#524）。
 *
 * ```
 * popularity(listing) = [ Σ_(identity, eventType) w(eventType) × 0.5^(age(该身份该类行为最近一次)/halflife_action)
 *                       + Σ_favorites            w_fav       × 0.5^(age(收藏行 created_at)/halflife_action) ]
 *                       × 0.5^(age(listing.created_at)/halflife_listing)
 * ```
 *
 * v1 是"每条事件行都加一次"，同一个人对同一件商品刷一百次 DETAIL_VIEW 就是一百倍热度，
 * 匿名会话又可以不带 `request_id` 直接上报 —— 热度可以被单个客户端任意刷高。v2 的三条口径：
 *
 * 1. **按 (listing, 身份, 事件类型) 去重**：每个身份对一件商品每类行为最多贡献一次权重，
 *    于是单身份对单商品的贡献有硬上限 Σw（即 per-identity cap），刷量只能靠堆身份。
 *    身份 = `user_id`，匿名事件为 `anonymous_session_id`（两者分开命名空间，见 `identityKey`）。
 * 2. **匿名事件必须归因到真实快照**：`request_id` 指向的服务端快照里确有这件商品
 *    （`recommendation_request_items`）才计入。匿名会话 id 是客户端随手生成的，不加这一条，
 *    "去重"只是让刷量者每次换一个 session id。登录用户的事件不受此限（身份本身是真值）。
 * 3. **收藏取 `favorites` 表的当前状态**：唯一约束保证一人一件一行，取消收藏即不再计入；
 *    事件流里的 FAVORITE 由调用方以 0 权重排除（`POPULARITY_ACTION_WEIGHTS`）。
 *
 * 两层衰减、调用方注入 `now`、`greatest(..., 0)` 兜住未来时间的口径与 v1 相同。
 * `listingIds` 给出时只算这批商品（排序层给全部候选补 feature），否则在全部可见商品里取 Top-K。
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
    /** 一条当前有效收藏的权重（`POPULARITY_FAVORITE_WEIGHT`）；0 = 不计收藏。 */
    favoriteWeight: number
    actionHalfLifeMs: number
    listingAgeHalfLifeMs: number
    /** 只算这批商品；省略 = 全部可见商品。 */
    listingIds?: readonly string[]
  },
): Promise<PopularRecallCandidate[]> {
  if (input.limit <= 0) return []
  if (input.listingIds !== undefined && input.listingIds.length === 0) return []
  const weights = input.weights.filter(({ weight }) => weight !== 0)
  if (weights.length === 0 && input.favoriteWeight === 0) return []

  const ageMs = (column: SQL) =>
    sql`greatest(extract(epoch from (${input.now}::timestamptz - ${column})) * 1000, 0)`
  const actionDecay = (column: SQL) =>
    sql`power(0.5, ${ageMs(column)} / ${input.actionHalfLifeMs}::double precision)`

  const signals: SQL[] = []

  if (weights.length > 0) {
    const weightCase = sql.join(
      weights.map(
        ({ eventType, weight }) =>
          sql`when ${recommendationEvents.eventType} = ${eventType} then ${weight}::double precision`,
      ),
      sql` `,
    )
    const identityKey = sql`coalesce('u:' || ${recommendationEvents.userId}::text, 'a:' || ${recommendationEvents.anonymousSessionId}::text)`
    const attributed = sql`(${recommendationEvents.userId} is not null or exists (
      select 1 from ${recommendationRequestItems}
      where ${recommendationRequestItems.requestId} = ${recommendationEvents.requestId}
        and ${recommendationRequestItems.listingId} = ${recommendationEvents.listingId}
    ))`
    const scope =
      input.listingIds === undefined
        ? sql``
        : sql` and ${inArray(recommendationEvents.listingId, [...input.listingIds])}`
    signals.push(sql`
      select ${recommendationEvents.listingId} as listing_id,
             (case ${weightCase} else 0 end) * ${actionDecay(sql`max(${recommendationEvents.occurredAt})`)} as score
      from ${recommendationEvents}
      where ${recommendationEvents.occurredAt} >= ${input.windowStart}
        and ${inArray(
          recommendationEvents.eventType,
          weights.map(({ eventType }) => eventType),
        )}
        and ${attributed}${scope}
      group by ${recommendationEvents.listingId}, ${recommendationEvents.eventType}, ${identityKey}`)
  }

  if (input.favoriteWeight !== 0) {
    const scope =
      input.listingIds === undefined
        ? sql``
        : sql` and ${inArray(favorites.listingId, [...input.listingIds])}`
    signals.push(sql`
      select ${favorites.listingId} as listing_id,
             ${input.favoriteWeight}::double precision * ${actionDecay(sql`${favorites.createdAt}`)} as score
      from ${favorites}
      where ${favorites.createdAt} >= ${input.windowStart}${scope}`)
  }

  const signalRows = sql`(${sql.join(signals, sql` union all `)}) as popularity_signals`
  const listingDecay = sql`power(0.5, ${ageMs(sql`${listings.createdAt}`)} / ${input.listingAgeHalfLifeMs}::double precision)`
  const popularity = sql<number>`sum(popularity_signals.score) * ${listingDecay}`

  const rows = await db
    .select({ listingId: listings.id, popularity })
    .from(signalRows)
    .innerJoin(listings, sql`${listings.id} = popularity_signals.listing_id`)
    .where(and(...visibleListingConditions(input.viewerUserId)))
    .groupBy(listings.id, listings.createdAt)
    .orderBy(desc(popularity), asc(listings.id))
    .limit(input.limit)

  // PG 的 `sum()` 可能回读为字符串：显式转数字，别让 "12" 这类字符串一路漂到排序器里。
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
  input: {
    userId: string
    limit: number
    /** 只取这批商品（排序层补 feature）；省略 = 我的全部匹配。 */
    listingIds?: readonly string[]
  },
): Promise<WishRecallCandidate[]> {
  if (input.limit <= 0) return []
  if (input.listingIds !== undefined && input.listingIds.length === 0) return []

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
        ...(input.listingIds === undefined
          ? []
          : [inArray(matches.listingId, [...input.listingIds])]),
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

export type ExploreRecallCandidate = { listingId: string; exposedIdentities: number }

/**
 * Exploration 通道：**曝光不足**的可见商品（#524）。
 *
 * 曝光不足 = 窗口内（`windowStart` 起）看到过它的**去重身份数** < `maxExposedIdentities`；
 * 取数按曝光身份数升序、发布时间降序（越少人见过、越新越先），上限 `limit`。
 *
 * v1 按"新商品 / 新卖家 / 冷门类目"拼，三块与 fresh / category 高度重叠，又只有首个来源是
 * explore 的候选才算探索位，结果探索配额几乎从不兑现。v2 直接用"有没有被看见"定义探索池：
 * 没有曝光的商品就没有行为，永远进不了 popular / semantic，这正是探索要破的循环。
 *
 * 身份口径与热度一致（`u:` / `a:` 两个命名空间）。曝光事件已有"每请求每商品一次"的唯一索引，
 * 去重身份再把"一个人刷十次 Feed"压成一次。
 */
export async function findUnderexposedRecallCandidates(
  db: Db,
  input: {
    limit: number
    viewerUserId: string | null
    /** 曝光统计窗口起点（`exploreExposureWindowStart(now)`）。 */
    windowStart: Date
    /** 去重曝光身份数严格小于它才算"曝光不足"。 */
    maxExposedIdentities: number
  },
): Promise<ExploreRecallCandidate[]> {
  if (input.limit <= 0 || input.maxExposedIdentities <= 0) return []

  // 从可见商品出发，逐个按 `listing_id` 索引数窗口内的去重曝光身份（`limit` 只截断计数结果，
  // 判断"是否 < 阈值"不需要精确总数）。只碰可见商品自己的曝光行：已下架 / 已售商品的曝光不再
  // 参与，也没有全窗口 group by；规模化后若仍成瓶颈，改为 worker 定时预计算曝光数。
  // `LATERAL` 让每个可见商品只算一次（标量子查询塞进 select / where / order by 会被执行三遍）。
  // 子查询里用显式别名 `ev` 与全限定的 `"listings"."id"`：drizzle 在单表 select 里渲染的列
  // 不带表名，关联条件会被就近解析到事件表自己身上。
  const exposure = db
    .select({ identities: sql<number>`count(*)::int`.as('identities') })
    .from(sql`(
      select distinct coalesce('u:' || ev.user_id::text, 'a:' || ev.anonymous_session_id::text)
      from ${recommendationEvents} as ev
      where ev.listing_id = "listings"."id"
        and ev.event_type = 'IMPRESSION'
        and ev.occurred_at >= ${input.windowStart}
      limit ${input.maxExposedIdentities}
    ) as exposed_identities`)
    .as('exposure')

  const rows = await db
    .select({ listingId: listings.id, exposedIdentities: exposure.identities })
    .from(listings)
    .innerJoinLateral(exposure, sql`true`)
    .where(
      and(
        ...visibleListingConditions(input.viewerUserId),
        sql`${exposure.identities} < ${input.maxExposedIdentities}`,
      ),
    )
    .orderBy(asc(exposure.identities), desc(listings.createdAt), desc(listings.id))
    .limit(input.limit)

  return rows.map((row) => ({
    listingId: row.listingId,
    exposedIdentities: Number(row.exposedIdentities),
  }))
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
 * `aggregateNegativeFeedback` 的 `weights` 同法），**不得包含 `IMPRESSION`** —— 互动次数用
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

export type NegativeFeedbackAggregate = {
  /** 类目 → 衰减后的负反馈权重和（全部类目，类目枚举很小）。 */
  categoryWeights: { category: ListingCategory; weight: number }[]
  /** 卖家 → 衰减后的负反馈权重和（只含 `candidateSellerIds` 里的卖家）。 */
  sellerWeights: { sellerId: string; weight: number }[]
  /** 被硬排除（`hiddenEventTypes`）的商品（只含 `candidateListingIds` 里的商品）。 */
  hiddenListingIds: string[]
}

/**
 * 某身份在时间窗内的**负反馈聚合**（#323 R4 的 `negativeFeedbackPenalty` 输入；#524 改为 SQL 聚合）。
 *
 * v1 把窗口内的原始事件全部取回 JS 再聚合，查询没有 LIMIT：一个隐藏/划过了几千件商品的老用户，
 * 每次刷 Feed 都要回传几千行。v2 把聚合下推到 SQL，返回行数有固定上界：
 *
 * - 类目惩罚按类目分组（≤ 类目枚举数）；
 * - 卖家惩罚只算本次候选里出现的卖家（≤ 候选数）；
 * - 硬排除只看本次候选里的商品（≤ 候选数）。
 *
 * 衰减公式与 v1 相同（`weight × 0.5^(max(age,0)/halfLife)`，权重表与半衰期由调用方传入），
 * 饱和映射仍在 api 侧做。身份谓词与 `countListingImpressions` 一致（匿名分支 `user_id IS NULL`）；
 * 索引 `recommendation_events_{user_id,session_id}_occurred_at_idx` 覆盖该谓词。
 */
export async function aggregateNegativeFeedback(
  db: Db,
  input: {
    identity: { kind: 'user'; id: string } | { kind: 'anonymous'; id: string }
    since: Date
    now: Date
    /** 负反馈事件类型 → 权重（取绝对值后的正数）。 */
    weights: readonly RecallActionWeight[]
    halfLifeMs: number
    /** 触发 listing 级硬排除的事件类型。 */
    hiddenEventTypes: readonly RecommendationEventType[]
    candidateListingIds: readonly string[]
    candidateSellerIds: readonly string[]
  },
): Promise<NegativeFeedbackAggregate> {
  const empty: NegativeFeedbackAggregate = {
    categoryWeights: [],
    sellerWeights: [],
    hiddenListingIds: [],
  }
  const weights = input.weights.filter(({ weight }) => weight !== 0)
  if (weights.length === 0 && input.hiddenEventTypes.length === 0) return empty

  const identityFilter =
    input.identity.kind === 'user'
      ? eq(recommendationEvents.userId, input.identity.id)
      : and(
          eq(recommendationEvents.anonymousSessionId, input.identity.id),
          isNull(recommendationEvents.userId),
        )
  const inWindow = gte(recommendationEvents.occurredAt, input.since)

  const weightCase = sql.join(
    weights.map(
      ({ eventType, weight }) =>
        sql`when ${recommendationEvents.eventType} = ${eventType} then ${weight}::double precision`,
    ),
    sql` `,
  )
  const decayedWeight = sql<number>`sum((case ${weightCase} else 0 end) * power(0.5, greatest(extract(epoch from (${input.now}::timestamptz - ${recommendationEvents.occurredAt})) * 1000, 0) / ${input.halfLifeMs}::double precision))`
  const weightTypes = weights.map(({ eventType }) => eventType)

  const [categoryRows, sellerRows, hiddenRows] = await Promise.all([
    weightTypes.length === 0
      ? Promise.resolve([])
      : db
          .select({ category: listings.category, weight: decayedWeight })
          .from(recommendationEvents)
          .innerJoin(listings, eq(listings.id, recommendationEvents.listingId))
          .where(
            and(identityFilter, inWindow, inArray(recommendationEvents.eventType, weightTypes)),
          )
          .groupBy(listings.category),
    weightTypes.length === 0 || input.candidateSellerIds.length === 0
      ? Promise.resolve([])
      : db
          .select({ sellerId: listings.sellerId, weight: decayedWeight })
          .from(recommendationEvents)
          .innerJoin(listings, eq(listings.id, recommendationEvents.listingId))
          .where(
            and(
              identityFilter,
              inWindow,
              inArray(recommendationEvents.eventType, weightTypes),
              inArray(listings.sellerId, [...new Set(input.candidateSellerIds)]),
            ),
          )
          .groupBy(listings.sellerId),
    input.hiddenEventTypes.length === 0 || input.candidateListingIds.length === 0
      ? Promise.resolve([])
      : db
          .selectDistinct({ listingId: recommendationEvents.listingId })
          .from(recommendationEvents)
          .where(
            and(
              identityFilter,
              inWindow,
              inArray(recommendationEvents.eventType, [...input.hiddenEventTypes]),
              inArray(recommendationEvents.listingId, [...input.candidateListingIds]),
            ),
          ),
  ])

  return {
    categoryWeights: categoryRows.map((row) => ({
      category: row.category,
      weight: Number(row.weight),
    })),
    sellerWeights: sellerRows.map((row) => ({
      sellerId: row.sellerId,
      weight: Number(row.weight),
    })),
    hiddenListingIds: hiddenRows.map((row) => row.listingId),
  }
}
