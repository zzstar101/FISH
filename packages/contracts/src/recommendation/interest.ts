import type { RecommendationEventType } from './schema'

/**
 * User Interest Profile 契约（Issue #323 / R2 — User Interest Profile）。
 *
 * 这里只放**没有 IO 的纯计算**与它的常量：行为权重、时间衰减半衰期、窗口口径、聚合函数。
 * 三个调用方共用同一份数值与同一段算法，因此"同输入 + 同 strategyVersion ⇒ 同画像"是可证的：
 *
 * - `apps/api`：请求时实时算 **session 画像**（近 50 条行为，半衰期 30 分钟）；
 * - `apps/worker`：`REFRESH_USER_INTEREST` job 从 0 全量重算 **长期画像**（近 180 天，半衰期 14 天）；
 * - 两侧都写 `user_interest_profiles`，行里记 `strategyVersion`（本文件的 `INTEREST_STRATEGY_VERSION`）。
 *
 * 为什么权重与半衰期不进 DB / env：它们决定画像形状，必须可版本化、可复现、可离线 fixture 回放
 * （验收要求"同输入 + 同 strategyVersion 结果可复现"）。放进 env 就没有版本号，改一次数值会让
 * 历史画像无法解释。数值本身**不是最终结论**，R4 的实验会调它们，调完改这里并升版本号。
 */

/**
 * 画像策略版本。数值或算法一改就要升版本。
 *
 * 写进 `user_interest_profiles.strategy_version`，作用是**让"这份画像由哪一版策略算出"可判**：
 * worker 每次重算都从 0 全量重算并覆盖这一列，所以"版本变则重算"由写入路径保证；
 * 而"旧版本的行不要当现行画像消费"是**读取方的事**——R2 自己还没有长期画像的消费方
 * （R3 才是），所以 `findUserInterestProfile` 目前只按 `(userId, model)` 取行，由 R3 决定是否
 * 用这一列过滤。session 画像不走这张表，每次请求现算，不存在版本漂移。
 */
export const INTEREST_STRATEGY_VERSION = 'interest-v1'

/**
 * 行为 → 兴趣强度的相对权重（Issue #323 M1 的 actionWeight）。
 *
 * 量纲是"相对强度"，不是概率：只有比值有意义（分子 `Σ w·decay·v`，分母 `Σ |w·decay|`）。
 *
 * - `IMPRESSION = 0`：**曝光不是兴趣**。用户在首页刷到一件商品什么都没做，不构成"喜欢"；
 *   给它非零权重会把"被系统推过"当成"用户想买"，这是推荐系统最典型的自我强化偏差。
 *   权重 0 的行为既不进分子也不进分母（见 `aggregateInterestVector`），连计数都不占。
 * - `QUICK_SKIP = -0.5` / `UNFAVORITE = -2` / `HIDE = -3`：**负权进分子**（反向兴趣向量），
 *   分母取 `|w|`——否则"讨厌 A、喜欢 B"会互相抵消成零向量，而用户其实有明确的兴趣方向。
 * - 强正反馈阶梯 `FAVORITE 4 < CHAT_START 5 < TRANSACTION_START 6 < PURCHASE 8`：
 *   对齐业务漏斗 曝光→详情→收藏→发起聊天/想要→交易→成交，越靠后越接近真实成交意图。
 */
export const INTEREST_ACTION_WEIGHTS: Record<RecommendationEventType, number> = {
  IMPRESSION: 0,
  DETAIL_VIEW: 1,
  LONG_VIEW: 2,
  IMAGE_VIEW: 0.5,
  QUICK_SKIP: -0.5,
  FAVORITE: 4,
  UNFAVORITE: -2,
  CHAT_START: 5,
  COMMENT: 3,
  TRANSACTION_START: 6,
  PURCHASE: 8,
  HIDE: -3,
}

/**
 * 权重为 0 的事件类型（SQL 层用它把这些行为挡在窗口之外）。
 *
 * 显式列出而不是从 `INTEREST_ACTION_WEIGHTS` 推导，是因为它要进 SQL 的 `NOT IN`：
 * 推导出的数组在 SQL 里读不出"为什么是这些"。`interest.test.ts` 里有一条断言把两者钉在一起，
 * 改权重而忘了改这里会立刻红。
 */
export const INTEREST_ZERO_WEIGHT_EVENT_TYPES: readonly RecommendationEventType[] = ['IMPRESSION']

/**
 * 时间衰减半衰期：`decay = 0.5 ** (ageMs / halfLifeMs)`。
 *
 * - `session = 30 分钟`：session 兴趣要"今天连看几件骑行装备就立刻偏向骑行"（Issue #323 M1）。
 *   30 分钟半衰期意味着 1 小时前的行为只剩 1/4 权重、半天前的几乎归零，响应速度由衰减自然给出，
 *   不需要维护"会话边界"（挂机 5 小时不会让旧行为仍满权重）。
 * - `longTerm = 14 天`：长期兴趣跨"教材 + 数码"这类以周为单位的偏好；14 天半衰期让 180 天窗口内
 *   的行为仍有区分度（最老的也有 `0.5**13 ≈ 1.2e-4`），而昨天的行为明显重于上个月的。
 */
export const INTEREST_HALF_LIFE_MS = {
  session: 30 * 60 * 1000,
  longTerm: 14 * 24 * 60 * 60 * 1000,
} as const

/**
 * session 画像只看**最近 50 条有权重的行为**（Issue #323 M1 "最近几十个行为快速更新"）。
 *
 * 是"条数窗"而不是"时间窗"：时间窗需要一个会话边界，而边界在移动端（切后台、断网重连、
 * 切号）判定不准；条数窗 + 衰减天然给出"越近越重要"，且查询代价恒定（走
 * `(user_id, occurred_at)` 索引取 50 行）。
 *
 * 注意"有权重"这个限定：R1 的首页每屏都会产生 `IMPRESSION`，若把曝光算进窗口，
 * 用户刷两屏就把 50 条名额用完，真正的 `DETAIL_VIEW` / `FAVORITE` 全被挤出去。
 */
export const INTEREST_SESSION_MAX_ACTIONS = 50

/** 长期画像的时间窗：与 R1 的事件 retention（180 天）对齐，超出的事件本来也会被清理。 */
export const INTEREST_LONG_TERM_WINDOW_DAYS = 180

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 参与聚合的行为回看起点：`now − 180 天`。
 *
 * session 与长期画像**共用同一个回看起点**，区别只在"怎么收窄"：session 用条数窗
 * （`INTEREST_SESSION_MAX_ACTIONS`）收窄，长期画像用更长的半衰期收窄。两者都不需要更早的行为
 * ——超过 retention 的事件本来就会被 R6 的清理作业删掉，SQL 侧提前排除还能少扫一段索引。
 */
export function interestLookbackStart(now: Date): Date {
  return new Date(now.getTime() - INTEREST_LONG_TERM_WINDOW_DAYS * DAY_MS)
}

/**
 * 衰减下溢阈值：`decay < 1e-6` 的行为**不再代表"当前兴趣"**，按不可用跳过并计数。
 *
 * 没有它的话，一个三个月没来的用户点开一件商品，session 画像仍会由那条远古行为生成一个
 * "看起来有效"的方向向量（数值上只是被 L2 归一化放大了）。宁可返回 null 让 R3 走冷启动，
 * 也不要拿远古行为冒充 session 兴趣。长期画像（14 天半衰期、180 天窗）最老也有 1.2e-4，
 * 永远碰不到这个阈值，所以同一个常量对两条路径都安全。
 */
export const INTEREST_MIN_ACTION_DECAY = 1e-6

/** 一条参与聚合的行为：事件类型 + 发生时间 + 该商品**当时**的向量（无可用向量时 null）。 */
export type InterestAction = {
  eventType: RecommendationEventType
  occurredAt: Date
  /**
   * 商品向量。调用方负责判定"可用"（同一 `model`、且向量与实体版本一致）；
   * 不可用一律传 `null`，由聚合函数按原因计数，**不做任何降级猜测**。
   */
  vector: readonly number[] | null
}

/** 被跳过的行为按原因分账——R6 的画像可观测性要用它解释"为什么这个用户没有画像"。 */
export type InterestSkipStats = {
  /** 没有可用向量（未生成 / 异模型 / 实体已编辑而过期 / 商品已删）。 */
  noVector: number
  /** 权重为 0 的行为（曝光类）。 */
  zeroWeight: number
  /** 衰减下溢（`< INTEREST_MIN_ACTION_DECAY`）。 */
  decayed: number
}

export type InterestVectorOutcome = {
  /** L2 归一化后的兴趣向量；没有任何可用行为时为 `null`（**绝不返回零向量**）。 */
  vector: number[] | null
  /** 真正参与聚合的行为条数。 */
  usedActions: number
  skipped: InterestSkipStats
}

export type InterestAggregationInput = {
  /**
   * 参与聚合的行为，由调用方按窗口选好（长期画像 = 180 天时间窗；session 画像 = 近 50 条）。
   * **条数窗在 SQL 侧收口**（见 `packages/db/src/user-interest-store.ts` 的 `limit`），
   * 而不是在本函数里切片：本函数只负责"给定这批行为算一个方向"，窗口口径只有一处。
   */
  actions: readonly InterestAction[]
  /** 计算"现在"的基准时刻；显式传入而不是取 `Date.now()`，否则无法复现。 */
  now: Date
  halfLifeMs: number
}

/**
 * 指数时间衰减。`ageMs <= 0`（客户端时钟超前，R1 已把超前 10 分钟以上的事件拒收）按 0 龄处理：
 * 早到的事件不该因为几秒的时钟漂移被罚，也不该因为"未来"拿到 >1 的权重。
 */
export function interestDecayFactor(ageMs: number, halfLifeMs: number): number {
  if (!(halfLifeMs > 0)) {
    throw new Error(`兴趣聚合：半衰期必须为正数，收到 ${halfLifeMs}`)
  }
  return 0.5 ** (Math.max(ageMs, 0) / halfLifeMs)
}

/**
 * `userInterest = Σ(actionWeight × timeDecay × listingEmbedding) / Σ|weight|`（Issue #323 M1）。
 *
 * 分母取**绝对值之和**而不是代数和：负权行为（`HIDE` / `UNFAVORITE` / `QUICK_SKIP`）参与的是
 * "反向兴趣"，带符号的分母会让"喜欢 A + 讨厌 B"在证据强度相当时除零或放大，而用户其实只是
 * 有明确方向。绝对值分母让结果保持"加权平均"的量纲（`Σ|w| > Σ|w·v|` 意义上的收敛）。
 *
 * 结果做 L2 归一化：下游（R3 语义召回）只用方向、用 cosine 比距离，归一化后与 `pgvector` 的
 * `<=>` 语义一致，也避免行为多的用户权重被放大。注意归一化之后**分母只影响"有没有画像"的
 * 判定**（零向量 / 无可用行为 → null），不影响排序方向——这是刻意的：一个用户画像的方向
 * 不应该因为他多刷了几件商品就变。
 *
 * 返回 `vector: null` 的两种情形：窗口内没有可用行为（含全被跳过），或加权和恰好归零
 * （正负完全抵消）。**任何情况下都不返回零向量**——零向量与所有商品 cosine 距离相同，
 * 会把"没有画像"伪装成"有画像"，R3 也就无法降级到冷启动。
 *
 * 维度取自第一条可用向量，之后不一致直接抛错：同一次聚合里出现两种维度说明上游的
 * `model`/维度过滤漏了，静默截断只会产出垃圾向量。
 */
export function aggregateInterestVector(input: InterestAggregationInput): InterestVectorOutcome {
  const { actions, now, halfLifeMs } = input
  const skipped: InterestSkipStats = { noVector: 0, zeroWeight: 0, decayed: 0 }

  const ordered = actions
    .map((action, index) => ({ action, index }))
    // 同一毫秒内的行为按传入顺序（= SQL 的次级排序）稳定处理，保证可复现。
    .sort(
      (left, right) =>
        right.action.occurredAt.getTime() - left.action.occurredAt.getTime() ||
        left.index - right.index,
    )

  let accumulator: number[] = []
  let denominator = 0
  let usedActions = 0
  const nowMs = now.getTime()

  for (const { action } of ordered) {
    const weight = INTEREST_ACTION_WEIGHTS[action.eventType]
    if (weight === 0) {
      skipped.zeroWeight += 1
      continue
    }
    const { vector } = action
    if (vector === null) {
      skipped.noVector += 1
      continue
    }
    const decay = interestDecayFactor(nowMs - action.occurredAt.getTime(), halfLifeMs)
    if (decay < INTEREST_MIN_ACTION_DECAY) {
      skipped.decayed += 1
      continue
    }
    if (accumulator.length === 0) {
      if (vector.length === 0) {
        throw new Error('兴趣聚合：商品向量为空数组')
      }
      accumulator = new Array<number>(vector.length).fill(0)
    }
    if (vector.length !== accumulator.length) {
      throw new Error(
        `兴趣聚合：向量维度不一致（期望 ${accumulator.length}，实际 ${vector.length}）`,
      )
    }
    const contribution = weight * decay
    for (let index = 0; index < accumulator.length; index += 1) {
      accumulator[index] = (accumulator[index] ?? 0) + contribution * (vector[index] ?? 0)
    }
    denominator += Math.abs(contribution)
    usedActions += 1
  }

  if (usedActions === 0 || denominator === 0) {
    return { vector: null, usedActions, skipped }
  }

  let sumSquares = 0
  for (const value of accumulator) {
    sumSquares += value * value
  }
  const magnitude = Math.sqrt(sumSquares)
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    return { vector: null, usedActions, skipped }
  }
  return { vector: accumulator.map((value) => value / magnitude), usedActions, skipped }
}
