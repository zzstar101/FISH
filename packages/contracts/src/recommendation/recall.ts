import type { RecommendationEventType, RecommendationSource } from './schema'

/**
 * Multi-channel Recall 契约（Issue #323 / R3 — Multi-channel Recall）。
 *
 * 这里只放**没有 IO 的常量与纯计算**：六路通道的集合与配额、兴趣向量合成、热度口径。
 * 三个调用方共用同一份数值，因此"同输入 + 同 `RECALL_STRATEGY_VERSION` ⇒ 同候选集"是可证的：
 *
 * - `apps/api`：召回编排（六路 provider + 合并去重 + 最终可见性再过滤）；
 * - `packages/db`：召回查询本身（本包**不 import contracts**，一切数值由调用方显式传入，
 *   与 `packages/db/src/user-interest-store.ts` 的 `zeroWeightEventTypes` 同一纪律）；
 * - 测试 fixture：用同一份常量钉住通路与数值，不写第二套数字。
 *
 * **R3 不接 Feed**：`startFeed` 仍是 `newest` 透传 + `rec-v1-none`，本文件产出的候选集还没有
 * HTTP 暴露面。真实接线与 rank/re-rank 归 R4/R5。
 */

/**
 * 召回策略版本。通道集合、配额、兴趣合成比例、热度口径任一改动都要升版本。
 *
 * 与 R2 的 `INTEREST_STRATEGY_VERSION` 分开：那是"画像是怎么算的"，这是"候选是怎么召回的"，
 * 两者可以独立演进（换画像算法不必改召回口径，反之亦然）。R4 的 `strategyVersion` 会把两者
 * 都写进推荐请求行，这里先把召回侧的版本号定下来。
 */
export const RECALL_STRATEGY_VERSION = 'recall-v1'

/**
 * 一期六路召回通道（Issue #323 M2）。
 *
 * `follow` / `similar` 不在其中：关注召回依赖 #188（尚无数据），item2item 相似归后续 CF 阶段。
 * 两条通道的枚举值在 R1 已冻结，等它们落地时不需要再改契约。
 */
export const RECALL_CHANNELS = [
  'fresh',
  'popular',
  'semantic',
  'wish',
  'category',
  'explore',
] as const satisfies readonly RecommendationSource[]

export type RecallChannel = (typeof RECALL_CHANNELS)[number]

/**
 * 单路召回条数上限（去重前）。
 *
 * 配额的意义不是"限制总量"，而是**防止一路吃满整个候选池**：semantic 高相似商品如果放开，
 * 会把 fresh / explore 全挤掉，新商品与新卖家就永远拿不到曝光（Issue #323 的业务目标之一）。
 * 合计 480（100+100+100+50+80+50），低于 `RECALL_MAX_CANDIDATES`，说明正常路径下**不会触发
 * 总量截断**；截断只是"某一路实现超标"的兜底。
 */
export const RECALL_CHANNEL_LIMITS: Record<RecallChannel, number> = {
  fresh: 100,
  popular: 100,
  semantic: 100,
  wish: 50,
  category: 80,
  explore: 50,
}

/**
 * 合并去重后的候选硬上限（Issue #323 的 200~500 区间上沿）。
 *
 * 超限时按"跨通道命中数优先、通道优先级次之"截断（见 `RECALL_CHANNEL_PRIORITY`）：
 * 被多路同时召回的候选证据更强，先被淘汰的应该是只有一路背书的尾部候选。
 */
export const RECALL_MAX_CANDIDATES = 500

/**
 * 截断时的通道优先级（越靠前越不容易被丢掉）。
 *
 * 顺序体现"个性化 > 相关性 > 热度 > 探索"：semantic / wish 是用户自己的信号，category 是近期
 * 行为的方向，popular 是大众信号，fresh 是"新商品保曝光"的兜底，explore 本来就是低比例探索流量。
 */
export const RECALL_CHANNEL_PRIORITY: readonly RecallChannel[] = [
  'semantic',
  'wish',
  'category',
  'popular',
  'fresh',
  'explore',
]

/**
 * `combined_interest = α·session + β·long_term`（Issue #323 M1）。
 *
 * α 偏 session（0.7）：session 画像用 30 分钟半衰期，它表达的是"现在想逛什么"，要能压过
 * 长期偏好的惯性；β 偏长期（0.3）：长期画像提供"这个人一直喜欢什么"的稳定项，避免一次误点
 * 就把首页带偏。**这不是冻结值**——issue 明说权重由实验决定，R6 拿到线上漏斗数据后调这两个数
 * 并升 `RECALL_STRATEGY_VERSION`。
 */
export const RECALL_INTEREST_MIX = {
  session: 0.7,
  longTerm: 0.3,
} as const

export type CombineInterestInput = {
  /** session 画像向量（`readSessionInterest` 的产出，L2 归一化后）。null = 没有 session 画像。 */
  session: readonly number[] | null
  /** 长期画像向量（`findUserInterestProfile` 的产出）。null = 没有长期画像。 */
  longTerm: readonly number[] | null
  /** 覆盖默认比例，仅供实验与测试；生产走 `RECALL_INTEREST_MIX`。 */
  mix?: { session: number; longTerm: number }
}

/**
 * 合成两路兴趣向量，输出 L2 归一化后的方向；**没有可用输入时返回 null（绝不返回零向量）**。
 *
 * 四种情形：
 *
 * 1. 两路都有 → `α·session + β·longTerm` 再归一化。归一化后 α/β 只影响**两路的相对占比**，
 *    不影响单路的量纲（否则"行为多的用户"会因为向量模长更大而在 cosine 里被放大）。
 * 2. 只有一路 → **直接用那一路**（归一化后与"另一路补零再按 β 缩放"数学等价）。
 *    这样"只有一个候选来源"不会因为比例系数把向量缩小，也让"新用户只有 session 行为"
 *    与"老用户本 session 没行为只有长期画像"走同一条确定路径。
 * 3. 两路都没有 → null：调用方**只跳过 semantic 一路**，靠 fresh / popular / category / wish /
 *    explore 凑齐候选（Issue #323 M1 的冷启动口径），而不是让首页空掉。
 * 4. 加权和恰好归零 / 非有限 → null：与 `aggregateInterestVector` 同一纪律，零向量会让
 *    pgvector 的距离排序退化成"随机顺序"，把"没有画像"伪装成"有画像"。
 *
 * 维度不一致或空数组**直接抛错**：同一次合成里出现两种维度说明上游的 model/维度过滤漏了，
 * 静默截断只会产出垃圾向量（与 `aggregateInterestVector` 同一处理）。
 */
export function combineInterestVectors(input: CombineInterestInput): number[] | null {
  const { session, longTerm } = input
  const normalizedSession = normalizeInterestVector(session, 'session')
  const normalizedLongTerm = normalizeInterestVector(longTerm, 'longTerm')

  if (normalizedSession === null && normalizedLongTerm === null) return null
  if (normalizedSession !== null && normalizedLongTerm === null) return normalizedSession
  if (normalizedSession === null && normalizedLongTerm !== null) return normalizedLongTerm

  // 两路都有：维度必须一致（两个画像来自同一个 embedding model）。
  const sessionVector = normalizedSession as number[]
  const longTermVector = normalizedLongTerm as number[]
  if (sessionVector.length !== longTermVector.length) {
    throw new Error(
      `兴趣合成：两路画像维度不一致（session ${sessionVector.length}，长期 ${longTermVector.length}）`,
    )
  }

  const mix = input.mix ?? RECALL_INTEREST_MIX
  const combined = new Array<number>(sessionVector.length).fill(0)
  for (let index = 0; index < combined.length; index += 1) {
    combined[index] =
      mix.session * (sessionVector[index] ?? 0) + mix.longTerm * (longTermVector[index] ?? 0)
  }
  return normalizeVector(combined)
}

function normalizeInterestVector(vector: readonly number[] | null, label: string): number[] | null {
  if (vector === null) return null
  if (vector.length === 0) {
    throw new Error(`兴趣合成：${label} 向量为空数组`)
  }
  return normalizeVector([...vector])
}

function normalizeVector(vector: readonly number[]): number[] | null {
  let sumSquares = 0
  for (const value of vector) {
    sumSquares += value * value
  }
  const magnitude = Math.sqrt(sumSquares)
  if (!Number.isFinite(magnitude) || magnitude === 0) return null
  return vector.map((value) => value / magnitude)
}

/**
 * 热度统计的时间窗（Issue #323 M2 "不能把历史爆款永久固定前排"）。
 *
 * 14 天与长期画像的 3~14 天量级一致：比这更长的窗口会让"上学期火过的教材"一直占着候选池，
 * 而校园二手的需求本身按学期轮换。
 */
export const POPULARITY_WINDOW_DAYS = 14

/**
 * 行为 → 热度贡献的权重。
 *
 * **刻意不复用 R2 的 `INTEREST_ACTION_WEIGHTS`**：两者语义不同，混用会让调参互相牵连。
 * - 兴趣权重是"这个人对这件商品的态度"，带负号（`HIDE` / `UNFAVORITE` 是反向兴趣）；
 * - 热度是"这件商品最近被多少人认可"，只有非负项，且询价/成交这类**稀缺但强**的信号要明显重
 *   （`PURCHASE 6 > TRANSACTION_START 5 > CHAT_START 4 > FAVORITE 3`），否则热门＝曝光多的商品，
 *   正是 issue 要防的"被系统推过就当成交"的自我强化。
 *
 * `IMPRESSION` / `QUICK_SKIP` / `UNFAVORITE` / `HIDE` 记为 0：曝光是系统给的、划过是弱负信号、
 * 隐藏是个体行为，三者都不该抬高一件商品的**公共热度**（负反馈在 R4 的 rank 里单独成项）。
 * 权重为 0 的事件类型由 `POPULARITY_ACTION_TYPES` 显式列出并进 SQL 的 `= ANY(...)`；
 * `recall.test.ts` 有一条断言把两张表钉在一起。
 */
export const POPULARITY_ACTION_WEIGHTS: Record<RecommendationEventType, number> = {
  IMPRESSION: 0,
  DETAIL_VIEW: 1,
  LONG_VIEW: 2,
  IMAGE_VIEW: 0.5,
  QUICK_SKIP: 0,
  FAVORITE: 3,
  UNFAVORITE: 0,
  CHAT_START: 4,
  COMMENT: 2,
  TRANSACTION_START: 5,
  PURCHASE: 6,
  HIDE: 0,
}

/** 计入热度的事件类型（权重 > 0）。显式列出：它要进 SQL 的 `= ANY(...)`，推导出来的数组读不出意图。 */
export const POPULARITY_ACTION_TYPES: readonly RecommendationEventType[] = [
  'DETAIL_VIEW',
  'LONG_VIEW',
  'IMAGE_VIEW',
  'FAVORITE',
  'CHAT_START',
  'COMMENT',
  'TRANSACTION_START',
  'PURCHASE',
]

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 单条行为的时间衰减半衰期：3 天。
 *
 * 比兴趣的 14 天（长期）短得多：热度要反映"最近", 一件商品上周被点开一百次不该压过昨天成交两单。
 * 比兴趣的 session 30 分钟长，是因为热度是**聚合量**，太短的半衰期会让热度在夜间归零、
 * 白天剧烈抖动，候选池跟着抖。
 */
export const POPULARITY_ACTION_HALF_LIFE_MS = 3 * DAY_MS

/**
 * 商品自身年龄的衰减半衰期：7 天。
 *
 * 与行为衰减相乘，得到"新商品自带一定热度加成、老商品必须靠持续互动维持"的效果——这正是
 * Issue #323 M2 要求的"不能把历史爆款永久固定前排"。
 */
export const POPULARITY_LISTING_AGE_HALF_LIFE_MS = 7 * DAY_MS

/** 热度统计起点：`now − POPULARITY_WINDOW_DAYS`。 */
export function popularityWindowStart(now: Date): Date {
  return new Date(now.getTime() - POPULARITY_WINDOW_DAYS * DAY_MS)
}

/**
 * 候选的 `freshness` feature（Issue #323 M3 的字段清单）用同一个商品年龄衰减系数。
 *
 * 复用 `POPULARITY_LISTING_AGE_HALF_LIFE_MS` 而不是另给一个数字：R3 的候选集里，"新鲜度"和
 * Popular 通道里的"商品年龄惩罚"必须是同一个量，否则同一件商品在两条路径上会有两个互相矛盾的
 * 新鲜度，R4 无论选哪个都是在两个不一致的定义里挑一个。
 */
export const RECALL_FRESHNESS_HALF_LIFE_MS = POPULARITY_LISTING_AGE_HALF_LIFE_MS

/**
 * Category / Recent Interest 通道取用户最近行为的**前几个类目**。
 *
 * 3 个：校园二手的兴趣通常集中在 1~2 个类目（教材 + 数码），取 3 是给"跨类目逛"留一个位置，
 * 又不至于让 80 条配额被摊薄到每个类目都不够用。
 */
export const RECALL_SESSION_CATEGORY_TOP_N = 3

/**
 * Exploration 通道内部三块的配比（Issue #323 M2 "新商品 / 新卖家 / 用户很少接触但可能相关的分类"）。
 *
 * 合计 50 = `RECALL_CHANNEL_LIMITS.explore`。冷门类目只给 10：它是"可能相关"的猜测，样本最少、
 * 最容易被噪声支配，比例不宜大；新商品 20 保证新发布能拿到首轮曝光，新卖家 20 让新卖家不至于
 * 一件都上不了首页。
 */
export const RECALL_EXPLORE_MIX = {
  newListing: 20,
  newSeller: 20,
  coldCategory: 10,
} as const

/** "新商品"窗口：发布 ≤ 3 天。 */
export const RECALL_EXPLORE_NEW_LISTING_WINDOW_MS = 3 * DAY_MS

/** "新卖家"窗口：卖家注册 ≤ 30 天（`users.created_at`）。 */
export const RECALL_EXPLORE_NEW_SELLER_WINDOW_MS = 30 * DAY_MS

/**
 * 候选去重时保留的召回来源上限。
 *
 * 上限只防"元数据膨胀"：一路候选的 `recallSources` 撑死六项，所以正常路径下不会截断；
 * 保留 `RECALL_CHANNEL_PRIORITY` 顺序，让下游看到的是"按优先级排的前几路"而不是随机几路。
 */
export const RECALL_MAX_SOURCES_PER_CANDIDATE = RECALL_CHANNELS.length
