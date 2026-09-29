import { and, asc, desc, eq, gte, inArray, isNull, lte, notInArray, sql } from 'drizzle-orm'
import type { Db } from './client'
import { newId } from './ids'
import { EMBEDDING_DIMENSIONS, embeddings } from './schema/embeddings'
import { listings } from './schema/listings'
import {
  recommendationEvents,
  type recommendationEventTypeEnum,
} from './schema/recommendation-events'
import { userInterestProfiles } from './schema/user-interest-profiles'

/**
 * 用户兴趣画像的读写（#323 R2）。
 *
 * 本模块只做三件事：**选出参与聚合的行为**（含"能不能用这条行为的向量"的判定）、
 * **落画像行**、**读/删画像行**。权重、衰减、归一化在
 * `@fish/contracts/recommendation/interest` 的纯函数里，provider 与 job 编排在 worker。
 *
 * ## 为什么"向量可用性"在本层判定（而不是交给调用方）
 *
 * session 画像（api，请求时实时算）与长期画像（worker，job 全量重算）必须**用同一套可用性规则**，
 * 否则同一批行为在两条路径上会算出不同的画像，"同输入同 strategyVersion 结果可复现"就不成立。
 * 规则与 #322 M2/M3 的候选新鲜度**完全一致**：`source_updated_at` 与实体 `updated_at` 按毫秒相等。
 * 判据在 JS 侧逐行重写（而不是复用 `freshListingsEmbedding()` 的 SQL 谓词）：聚合需要把"没有本模型
 * 向量"、"有旧模型向量"、"有本模型向量但已过期"分开对账，而 SQL 谓词只能给出"新鲜/不新鲜"两态。
 *
 * 只算"eventType 在窗口内 + 身份匹配"的行为；商品被删时事件随 `listing_id` 的 CASCADE 一起消失，
 * 因此不会出现"事件还在、商品没了"的行。
 *
 * **不按商品当前状态过滤**：行为是历史事实（用户当时确实看了/收藏了），SOLD / 下架 都不会让这条
 * 兴趣变假；"不可见商品不返回"是召回与最终返回前的事（#323 M3），不是画像的事。
 */

/** 行为事件类型（与 `@fish/contracts/recommendation/schema` 的同名联合结构一致，刻意不 import）。 */
export type RecommendationEventType = (typeof recommendationEventTypeEnum.enumValues)[number]

/**
 * 行为归属的身份。**两种身份不合并**（R2 决策）：长期画像只给登录用户，匿名会话只在请求时
 * 实时算 session 画像。匿名分支额外要求 `user_id IS NULL`——同一台设备的匿名会话 id 在
 * 登录后可能继续随事件上报（R1 的事件可同时带 user_id 与 anonymous_session_id），
 * 不排掉这些行就等于拿"登录后的行为"去喂匿名身份，正是跨身份合并。
 */
export type InterestIdentity = { kind: 'user'; id: string } | { kind: 'anonymous'; id: string }

/** 一条行为的向量不可用原因。与 R6 的画像可观测性对齐（"为什么这个用户没有画像"）。 */
export type InterestSkipReason = 'missing' | 'model_mismatch' | 'stale' | 'dimension_mismatch'

export type LoadedInterestAction = {
  eventType: RecommendationEventType
  occurredAt: Date
  /** 可用时给出向量（当前模型 + 新鲜）；不可用一律 `null`，原因在 `skipped` 分账。 */
  vector: number[] | null
}

export type LoadInterestActionsInput = {
  identity: InterestIdentity
  /** 当前 embedding 模型；异模型的向量一律不可用（不同模型的向量不可比较，#322 M1）。 */
  model: string
  /** 时间窗起点（含）。session 画像用宽窗（由条数兜住），长期画像用 180 天。 */
  since: Date
  /**
   * 只取最近 N 条**有权重**的行为（session = 50）；不传 = 时间窗内全量（长期画像）。
   *
   * 零权事件在 SQL 里就被排除，所以窗口名额全留给真实行为——否则首页每屏的 IMPRESSION
   * 会瞬间占满 50 条，把用户真正点开/收藏的行为挤出窗口。
   */
  limit?: number | undefined
  /** 零权事件类型（`INTEREST_ZERO_WEIGHT_EVENT_TYPES`）。显式传入：本层不 import contracts。 */
  zeroWeightEventTypes: readonly RecommendationEventType[]
}

export type LoadedInterestActions = {
  /** 窗口内的行为，按 `occurredAt` 降序（新 → 旧），同刻按 id 升序稳定。 */
  actions: LoadedInterestAction[]
  /** 被跳过行为的按原因分账；总数 = 窗口内行为数 − 可用向量行为数。 */
  skipped: Record<InterestSkipReason, number>
}

/**
 * 读取参与聚合的行为，并逐条判定向量可用性。
 *
 * 两条查询而不是一条宽 join：一条 join 会按"行为 × 该商品的各模型向量"放大行数，
 * 让 `LIMIT`（最近 50 条行为）在 SQL 层就不再等于"最近 50 条行为"。先取窗口行为、再按
 * `listing_id IN (...)` 取向量，窗口语义与条数上限都精确。
 */
export async function loadUserInterestActions(
  db: Db,
  input: LoadInterestActionsInput,
): Promise<LoadedInterestActions> {
  const identityFilter =
    input.identity.kind === 'user'
      ? eq(recommendationEvents.userId, input.identity.id)
      : and(
          eq(recommendationEvents.anonymousSessionId, input.identity.id),
          isNull(recommendationEvents.userId),
        )

  const filters = [
    identityFilter,
    gte(recommendationEvents.occurredAt, input.since),
    notInArray(recommendationEvents.eventType, [...input.zeroWeightEventTypes]),
  ]

  const windowQuery = db
    .select({
      id: recommendationEvents.id,
      eventType: recommendationEvents.eventType,
      occurredAt: recommendationEvents.occurredAt,
      listingId: recommendationEvents.listingId,
    })
    .from(recommendationEvents)
    .where(and(...filters))
    .orderBy(desc(recommendationEvents.occurredAt), asc(recommendationEvents.id))

  const window =
    input.limit === undefined ? await windowQuery : await windowQuery.limit(input.limit)

  const skipped: Record<InterestSkipReason, number> = {
    missing: 0,
    model_mismatch: 0,
    stale: 0,
    dimension_mismatch: 0,
  }

  if (window.length === 0) {
    return { actions: [], skipped }
  }

  const listingIds = [...new Set(window.map((row) => row.listingId))]

  /*
   * 取这些商品**所有模型**的向量行，而不是只取当前模型：只有这样才能把
   * "从来没有生成本模型的向量"（missing）与"有向量但属于旧模型、需要 backfill"（model_mismatch）
   * 分开——两者对聚合都是不可用，但成因不同，线上排障与换模型重建都要能看出来
   * （与 #322 的 `hasEmbeddingFromOtherModel` 同一动机）。
   */
  const embeddingRows = await db
    .select({
      listingId: embeddings.listingId,
      model: embeddings.model,
      dimensions: embeddings.dimensions,
      sourceUpdatedAt: embeddings.sourceUpdatedAt,
      embedding: embeddings.embedding,
      listingUpdatedAt: listings.updatedAt,
    })
    .from(embeddings)
    .innerJoin(listings, eq(listings.id, embeddings.listingId))
    .where(inArray(embeddings.listingId, listingIds))

  /**
   * 一个商品的向量可用性。**先收齐所有行、再判定原因**，不在遍历中就地定案：
   * 换模型 backfill 期间同一商品会同时存在"当前模型但过期"与"旧模型"两行，
   * 就地写 `Map` 会让原因随数据库返回行序漂移（`stale` 与 `model_mismatch` 互换），
   * 而"不可用原因分账"是要能被断言与对账的（#323 M1 / R6 可观测性）。
   *
   * `(listing_id, model)` 上唯一索引保证当前模型那一行最多一条，所以这里不需要优先级规则。
   */
  type Availability = {
    /** 当前模型的那一行；没有则 `null`（此时只可能是 missing 或 model_mismatch）。 */
    currentModel: {
      dimensions: number
      sourceUpdatedAt: Date
      listingUpdatedAt: Date
      embedding: number[]
    } | null
    hasOtherModel: boolean
  }
  const availability = new Map<string, Availability>()

  for (const row of embeddingRows) {
    if (row.listingId === null) {
      continue
    }
    const entry = availability.get(row.listingId) ?? { currentModel: null, hasOtherModel: false }
    if (row.model === input.model) {
      entry.currentModel = {
        dimensions: row.dimensions,
        sourceUpdatedAt: row.sourceUpdatedAt,
        listingUpdatedAt: row.listingUpdatedAt,
        embedding: row.embedding,
      }
    } else {
      entry.hasOtherModel = true
    }
    availability.set(row.listingId, entry)
  }

  /**
   * 判定一条行为的向量能不能用。顺序固定：维度 → 新鲜度 → 没有当前模型行时才是 `model_mismatch`。
   *
   * 新鲜度与 `freshListingsEmbedding()` 同一判据（`source_updated_at` = 实体 `updated_at`）。
   * SQL 侧的 `date_trunc('milliseconds', …)` 在 JS 侧就是**直接比毫秒**：`pg` 返回的 timestamp
   * 是 JS `Date`（只有毫秒分辨率），`now()` 写入的微秒部分在读回时已被截掉，与
   * `source_updated_at`（应用侧 Date 写入，本来就只有毫秒）可比。这里必须逐行判，
   * 才能把 `stale` 与 `missing` 分开。
   */
  function resolveAvailability(
    listingId: string,
  ): { vector: number[]; reason: null } | { vector: null; reason: InterestSkipReason } {
    const entry = availability.get(listingId)
    if (entry === undefined) {
      return { vector: null, reason: 'missing' }
    }
    const current = entry.currentModel
    if (current === null) {
      // entry 只可能由某一行创建：没有当前模型行就是有旧模型行。
      return { vector: null, reason: 'model_mismatch' }
    }
    if (current.dimensions !== EMBEDDING_DIMENSIONS) {
      return { vector: null, reason: 'dimension_mismatch' }
    }
    if (current.sourceUpdatedAt.getTime() !== current.listingUpdatedAt.getTime()) {
      return { vector: null, reason: 'stale' }
    }
    return { vector: current.embedding, reason: null }
  }

  const actions: LoadedInterestAction[] = window.map((row) => {
    const available = resolveAvailability(row.listingId)
    if (available.reason !== null) {
      skipped[available.reason] += 1
      return { eventType: row.eventType, occurredAt: row.occurredAt, vector: null }
    }
    return { eventType: row.eventType, occurredAt: row.occurredAt, vector: available.vector }
  })

  return { actions, skipped }
}

export type UserInterestProfileRow = {
  userId: string
  model: string
  dimensions: number
  strategyVersion: string
  embedding: number[]
  actionCount: number
  windowStartedAt: Date
  computedAt: Date
}

export type SaveUserInterestProfileInput = {
  userId: string
  model: string
  dimensions: number
  strategyVersion: string
  embedding: number[]
  actionCount: number
  windowStartedAt: Date
  /**
   * **读取行为数据那一刻**的时刻（不是算完之后），用作 CAS 版本号：
   * 一次读完数据才开始算的 job，若期间有更晚的 job 写入，它的 `computed_at` 更小，
   * 晚到时会被静默丢弃。与 #322 `saveEmbedding` 的 `source_updated_at` 同一手法。
   */
  computedAt: Date
}

/**
 * 写入/覆盖某用户在某模型下的画像（`(user_id, model)` 唯一）。
 *
 * **带 CAS**：`excluded.computed_at >= user_interest_profiles.computed_at`，返回值表示"这次到底
 * 写没写进去"。同一毫秒的重写（幂等重算）允许通过——`>=` 而不是 `>`，理由同 #322：同一毫秒内的
 * 两次重算读到的数据窗口相同，谁写都一样。
 */
export async function saveUserInterestProfile(
  executor: Pick<Db, 'insert'>,
  input: SaveUserInterestProfileInput,
): Promise<boolean> {
  const values = {
    id: newId(),
    userId: input.userId,
    model: input.model,
    dimensions: input.dimensions,
    strategyVersion: input.strategyVersion,
    embedding: input.embedding,
    actionCount: input.actionCount,
    windowStartedAt: input.windowStartedAt,
    computedAt: input.computedAt,
  }

  // `updated_at` 必须显式写：`$onUpdate` 只挂在 drizzle 的 `.update()` 上（与 #322 同一注意点）。
  const patch = {
    dimensions: values.dimensions,
    strategyVersion: values.strategyVersion,
    embedding: values.embedding,
    actionCount: values.actionCount,
    windowStartedAt: values.windowStartedAt,
    computedAt: values.computedAt,
    updatedAt: new Date(),
  }

  const rows = await executor
    .insert(userInterestProfiles)
    .values(values)
    .onConflictDoUpdate({
      target: [userInterestProfiles.userId, userInterestProfiles.model],
      set: patch,
      setWhere: sql`excluded."computed_at" >= ${userInterestProfiles.computedAt}`,
    })
    .returning({ id: userInterestProfiles.id })

  return rows.length > 0
}

/**
 * 读某用户在当前模型下的画像。**返回 `null` 表示"没有画像"**（新用户、行为不足、或者
 * 重算时窗口内已无可用向量），调用方据此走冷启动，而不是拿零向量当画像用。
 */
export async function findUserInterestProfile(
  executor: Pick<Db, 'select'>,
  input: { userId: string; model: string },
): Promise<UserInterestProfileRow | null> {
  const rows = await executor
    .select({
      userId: userInterestProfiles.userId,
      model: userInterestProfiles.model,
      dimensions: userInterestProfiles.dimensions,
      strategyVersion: userInterestProfiles.strategyVersion,
      embedding: userInterestProfiles.embedding,
      actionCount: userInterestProfiles.actionCount,
      windowStartedAt: userInterestProfiles.windowStartedAt,
      computedAt: userInterestProfiles.computedAt,
    })
    .from(userInterestProfiles)
    .where(
      and(
        eq(userInterestProfiles.userId, input.userId),
        eq(userInterestProfiles.model, input.model),
      ),
    )
    .limit(1)

  return rows[0] ?? null
}

/**
 * 删除某用户在某模型下的画像，返回删掉的行数。
 *
 * 用途：重算时**窗口内已无任何可用向量**（行为被清理、商品被删、全部过期）时，把旧画像一起删掉。
 * 全量重算的语义是"当前数据算出来的画像"，旧行留着会让 R3 继续消费一份其证据已不存在的画像，
 * 且 `strategy_version` 与 `computed_at` 会停止前进——看起来"有画像"，实际已经没有任何行为支撑。
 * 删掉之后读取返回 `null`，R3 走冷启动，这才是诚实的降级。
 *
 * **删除也要走 `computed_at` 的 CAS**（与 `saveUserInterestProfile` 的 `setWhere` 同一判据）：
 * 两个 worker 并发处理同一用户时，A 的结果来自 T1、B 的结果来自 T2 > T1，若 A 的"删"不受约束，
 * 它会把 B 刚写好的更新画像抹掉，用户的长期画像要等到下一条行为才恢复。因此只删
 * `computed_at <= input.computedAt` 的行：删掉 0 行说明库里有比本次计算更新的结果，调用方按
 * "已有更新写入"处理，而不是当成"本来就没有画像"。
 */
export async function deleteUserInterestProfile(
  executor: Pick<Db, 'delete'>,
  input: { userId: string; model: string; computedAt: Date },
): Promise<number> {
  const rows = await executor
    .delete(userInterestProfiles)
    .where(
      and(
        eq(userInterestProfiles.userId, input.userId),
        eq(userInterestProfiles.model, input.model),
        lte(userInterestProfiles.computedAt, input.computedAt),
      ),
    )
    .returning({ id: userInterestProfiles.id })

  return rows.length
}
