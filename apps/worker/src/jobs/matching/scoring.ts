import type { ListingCategory } from '@fish/contracts/listings/schema'
import {
  RANKING_VERSION,
  RANKING_VERSION_V1,
  SEMANTIC_SCORE_CEILING,
  SEMANTIC_SCORE_FLOOR,
} from '@fish/contracts/matching/schema'

/**
 * Match Engine 的打分（Issue #8 契约评论 §3.2；#322 M3 增加语义分与 hybrid 权重）。
 *
 * 纯函数、不碰 DB：`Backend Done` 要求"给定 fixture Listing/Wish 能稳定得到预期分数"，
 * 所以打分必须能在没有数据库的情况下断言。候选集收窄（category / price 先删候选）与向量
 * 召回（Top-K）都在 `engine.ts` 里，本文件只负责"给定事实 + 一个 cosine 相似度 → 0–100"。
 *
 * 只在这里定义权重与阈值语义，别处不得再写一套 0.35 / 0.35 / 0.30 或 v2 的四路权重。
 */

/** v1 三路权重（契约 §3.2 冻结），和恒为 1。 */
const WEIGHTS_V1 = { category: 0.35, keyword: 0.35, price: 0.3 } as const

/** v1 归一化后用于"不限分类"的权重和（`wishes.category IS NULL`，契约 §3.2）。 */
const WEIGHTS_V1_WITHOUT_CATEGORY = WEIGHTS_V1.keyword + WEIGHTS_V1.price

/**
 * v2 四路权重（#322 M3），四项和恒为 1。
 *
 * 与 v1 的关系：v1 的三项按比例缩放后**不是**任何一组候选——v1 是"没有语义分"的那一版，
 * 语义不可用时逐位退回它（见 `scoreMatch` 的 `semantic === null` 分支）。
 */
export type RankingWeights = {
  semantic: number
  category: number
  keyword: number
  price: number
}

/**
 * 打分参数（#322 M4）：把"锚点 + 不限分类口径 + acceptSimilar 门禁口径"抽成可注入参数，
 * 好让 `rank:compare` / `embed:eval --sections=fit` 用**生产的同一份代码**复算候选参数，
 * 而不是在校准脚本里再写一套公式。
 *
 * 默认值 = 当前生产行为（`DEFAULT_SCORING_PARAMS`），所以 `scoreMatch()` 的调用方零漂移；
 * M4 重标定只改这里的默认值，不改任何公式。
 */
export type ScoringParams = {
  semanticFloor: number
  semanticCeiling: number
  /**
   * `wish.category === null`（不限分类）时的口径：
   *   * `renormalize`：跳过 category 分项、把它的权重摊到其余三项（M3 冻结行为）；
   *   * `satisfied`：分类约束天然满足，category 分项按 100 计（结构证据不再被摊薄）。
   */
  nullCategoryMode: 'renormalize' | 'satisfied'
  /**
   * `acceptSimilar = false` 的门禁口径：
   *   * `keyword-or-category`：关键词命中 > 0 **或**分类精确命中即可让语义参与（M3 冻结行为）；
   *   * `keyword-only`：只有关键词命中才让语义参与（分类等值不算"结构证据"）。
   */
  acceptSimilarGate: 'keyword-or-category' | 'keyword-only'
}

/**
 * M4 重标定后的生产参数（2026-09-26，57 条冻结标注对上 53/57 一致，M3 旧参数 39/57）。
 *
 * 三处改动的证据都在 `bun run embed:eval`（§calibration 冻结标签一致度 + §fit 网格搜索）：
 *   1. 锚点 `0.42 / 0.70`（契约常量，理由见那里的注释）；
 *   2. `nullCategoryMode: 'satisfied'`：修掉 v2 相对 v1 的**回退**——不限分类的愿望在
 *      `renormalize` 下被摊薄，`cal-unlimited-phone`（关键词"手机"精确命中 + 预算内）v1 = 100
 *      分而 v2 只有 58 分（低于阈值），"语义接入反而让本来能成的对失配"；
 *   3. `acceptSimilarGate: 'keyword-only'`：M3 的口径让"分类命中"也算结构支撑，
 *      `cal-acceptfalse-tent` / `cal-acceptfalse-guitar`（分类相同、词法 0 命中、只有语义接近）
 *      被放行到 74–76 分，与 #322 验收"不能仅凭高语义跨产品召回"直接冲突。
 *
 * 阈值 `MATCH_SCORE_THRESHOLD = 70` 与权重 `WEIGHTS_V2`（S4）**未变**：网格搜索里它们不是
 * 瓶颈（平顶上最好的候选换权重也只多 0 条），改它们等于把 M3 的排名表全部作废。
 */
export const DEFAULT_SCORING_PARAMS = {
  semanticFloor: SEMANTIC_SCORE_FLOOR,
  semanticCeiling: SEMANTIC_SCORE_CEILING,
  nullCategoryMode: 'satisfied',
  acceptSimilarGate: 'keyword-only',
} as const satisfies ScoringParams

/**
 * M3 的权重对照组（`bun run rank:compare` 可复算，设计文档 §权重冻结有排名表）。
 *
 * S1/S2/S3 是 grilling 时先定的三组候选；跑完人工标注 fixture（12 条，覆盖 Issue 点名的
 * 九类样本）后三组都无法同时满足硬约束，于是按同样的约束补算了 S4 并冻结它：
 *   * S1 均衡：结构权重和 0.70（stub 环境语义分恒 0 时结构全中的对恰好 70 ✅），但
 *     "不限分类 + 无关键词命中"的对照上限只有 67 ⇒ 语义召回对不限分类的愿望数学上无效
 *     （9/12 一致）。
 *   * S2 偏结构：语义只占 0.20 ⇒ 同义 / 品牌型号对停在 67 / 68，语义召回基本失效
 *     （8/12 一致）。
 *   * S3 偏语义：语义召回最强，但结构权重和只有 0.60 ⇒ CI（EMBEDDING_TRANSPORT=stub）
 *     里 K380 demo 只有 60 分、不再成立；分类不符的历史行还升到 74 被重新显示
 *     （10/12 一致）。
 *   * S4 **冻结**：12/12 与人工判断一致；结构权重和恰为 0.70（stub 下结构全中的对压线
 *     过阈值）；同分类 + 无关键词命中的对 cos >= 0.725 即可召回（生产尺度，Issue 点名的
 *     AirPods 场景），不限分类的对需要 cos >= 0.87；分类不符 + 语义满分仍 < 70。
 *
 * 候选组留在代码里是为了让"为什么冻结这一组"可复算：改权重必须重跑 `rank:compare`、
 * `ranking.test.ts`，并更新设计文档的排名表。
 */
export const SEMANTIC_WEIGHT_CANDIDATES = {
  S1: { semantic: 0.3, category: 0.25, keyword: 0.25, price: 0.2 },
  S2: { semantic: 0.2, category: 0.3, keyword: 0.3, price: 0.2 },
  S3: { semantic: 0.4, category: 0.2, keyword: 0.2, price: 0.2 },
  S4: { semantic: 0.3, category: 0.32, keyword: 0.15, price: 0.23 },
} as const satisfies Record<string, RankingWeights>

/**
 * M3 **冻结**的 v2 权重：S4（fixture 12/12 与人工判断一致，见设计文档 §权重冻结）。
 *
 * 改这个常量 = 改线上排序，必须同时更新设计文档的对照表与 `ranking.test.ts` 的期望排名。
 */
export const WEIGHTS_V2: RankingWeights = SEMANTIC_WEIGHT_CANDIDATES.S4

export type MatchListingFacts = {
  title: string
  description: string
  priceCents: number
  category: ListingCategory
}

export type MatchWishFacts = {
  keyword: string
  /** `null` = 不限分类（DB 允许，契约 §3.2 对它有专门规则）。 */
  category: ListingCategory | null
  budgetMaxCents: number | null
  /**
   * 愿望的"接受相似品"开关（#322 M3 起有真实语义）：
   * `false` 时语义不能单独成立（见 `scoreMatch` 的门禁），`true` 时语义正常计权。
   */
  acceptSimilar: boolean
}

/**
 * 语义输入（#322 M3）：engine 从 pgvector 距离换算出的原始 cosine 相似度。
 *
 * `null` 表示**这一对拿不到语义分**（目标向量缺失/过期/模型不匹配，或候选侧没有向量）——
 * 与"语义分是 0"是两件事：前者退回 v1 算法（`semanticScore = null`、`rankingVersion = 1`），
 * 后者是 v2 算出的真实 0 分。
 */
export type MatchSemanticInput = {
  /** 原始 cosine 相似度，`1 - pgvector 距离`，理论上落在 -1..1。 */
  similarity: number
}

export type MatchScoreBreakdown = {
  score: number
  categoryScore: number
  keywordScore: number
  priceScore: number
  /** v2 的语义分项（0–100 整数）；`null` = 这一行由 v1 算法算出。 */
  semanticScore: number | null
  /** 这一行的算法版本，与 `packages/contracts/src/matching/schema.ts` 的两个常量一一对应。 */
  rankingVersion: typeof RANKING_VERSION_V1 | typeof RANKING_VERSION
}

/**
 * keyword 的 token 切分：按空白切。
 *
 * #7 的写入路径会把 keyword 转小写（`wishes/schema.ts` 的 `keywordSchema` transform），
 * 所以这里统一做大小写不敏感比较，两侧都不再各自 lowercase 一次。
 */
export function keywordTokens(keyword: string): string[] {
  return keyword
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
}

/**
 * 命中 = `title` 或 `description` 包含该 token（大小写不敏感）。
 *
 * 刻意不用 pg_trgm：实测 `similarity('机械键盘','罗技 K380 机械键盘') = 0.385`、
 * `similarity('高等数学 教材','高等数学上册（同济第七版）') = 0.235`——中文短词在长标题里的
 * trigram 相似度天然很低，会把主 Demo 那对打到 38 分。同义词/品牌词扩展是 P1。
 */
export function keywordScore(listing: MatchListingFacts, keyword: string): number {
  const tokens = keywordTokens(keyword)
  if (tokens.length === 0) return 0

  const haystack = `${listing.title}\n${listing.description}`.toLowerCase()
  const hits = tokens.filter((token) => haystack.includes(token.toLowerCase())).length
  return Math.round((hits / tokens.length) * 100)
}

/**
 * 价格分：`budgetMaxCents` 为 NULL（不限预算）或在预算内 → 100；超出预算后线性衰减，
 * 到 **2 倍预算**归零（契约 §3.2）。
 *
 * 2 倍这个数与 `engine.ts` 的候选集收窄相同，但两处不是同一件事：收窄直接**排除**
 * `price > 2 × budget_max` 的候选（产品规则），所以那些对根本不会被打分——即使分类与关键词
 * 都满分（那会得 70 分，本可以过阈值）。不要把它读成"只排除 priceScore = 0 的候选"。
 */
export function priceScore(listing: MatchListingFacts, budgetMaxCents: number | null): number {
  if (budgetMaxCents === null) return 100
  if (listing.priceCents <= budgetMaxCents) return 100
  // 预算为 0（"0 元送"类愿望）：任何非 0 价格都已经越过 2 倍界限。
  if (budgetMaxCents <= 0) return 0

  const decayed = (100 * (2 * budgetMaxCents - listing.priceCents)) / budgetMaxCents
  return Math.max(0, Math.round(decayed))
}

/** 分类等值打分：相等 100，否则 0（`listings.ts` 的注释："#8 的匹配按分类等值打分"）。 */
export function categoryScore(
  listing: MatchListingFacts,
  category: ListingCategory | null,
): number {
  return category !== null && listing.category === category ? 100 : 0
}

/**
 * 语义分归一化（#322 M3）：分段线性锚点，把 cosine 映射到 0–100 的整数。
 *
 * `clamp((similarity - FLOOR) / (CEILING - FLOOR), 0, 1) × 100`
 *
 * 锚点定义在契约里（`SEMANTIC_SCORE_FLOOR` / `SEMANTIC_SCORE_CEILING`），原因与校准依据见那里的注释：
 * 直接把 [-1, 1] 线性铺到 0–100 会让真实 embedding 的所有对挤进 60–98，失去区分度。
 * 低于 FLOOR 一律 0（"没有语义相关性"），高于 CEILING 一律 100。
 */
export function normalizeSimilarity(
  similarity: number,
  floor: number = SEMANTIC_SCORE_FLOOR,
  ceiling: number = SEMANTIC_SCORE_CEILING,
): number {
  const span = ceiling - floor
  const ratio = (similarity - floor) / span
  return Math.round(Math.min(1, Math.max(0, ratio)) * 100)
}

/**
 * `acceptSimilar = false` 的门禁（#322 M3 引入，M4 收紧口径）：语义**不能单独**把一对变成有效匹配。
 *
 * 结构上有真实支撑（默认口径 `keyword-only` = 关键词命中 > 0；M3 的 `keyword-or-category`
 * 把"分类精确命中"也算支撑）时才让语义分项参与；否则这一对的语义分记 0
 * ——注意是"记 0"而不是"剔掉语义项再归一化"：后者会让同一对在两种状态下用两套权重，
 * 分数不可比（见设计文档 §acceptSimilar）。
 *
 * M4 收紧到 `keyword-only` 的理由：分类等值在"同分类但不同产品"时恒成立（校园二手场景里
 * DIGITAL 下既有键盘也有耳机），把它当结构支撑等于让 `acceptSimilar = false` 形同虚设——
 * 57 条冻结标注对里 `cal-acceptfalse-tent` / `cal-acceptfalse-guitar` 就是这么被放行到
 * 74–76 分的，与 #322 验收"不能仅凭高语义跨产品召回"冲突。
 *
 * 这条规则只拦"仅凭高语义跨产品召回"：v1 今天能成的对（关键词或分类命中）在 v2 下不受影响。
 */
function semanticAllowed(
  wish: MatchWishFacts,
  keyword: number,
  category: number,
  params: ScoringParams,
): boolean {
  if (wish.acceptSimilar) return true
  if (params.acceptSimilarGate === 'keyword-only') return keyword > 0
  return keyword > 0 || category > 0
}

/**
 * 总分（#322 M3 起是 hybrid）：`semantic` 为 `null` 时逐位退回 v1 三路权重。
 *
 * **v1 分支**（`semantic === null`，即这一对拿不到 cosine）：权重、归一化、"不限分类"规则
 * 与 #8 冻结的实现完全一致，`semanticScore = null`、`rankingVersion = 1`。这样 K380 demo、
 * 没有 embeddings 的环境、以及 M2 的降级路径行为零漂移。
 *
 * **v2 分支**（`semantic !== null`）：四路权重（`weights`，默认 `WEIGHTS_V2`），
 * `semanticScore` 为归一化后的 0–100 整数、`rankingVersion = 2`；`acceptSimilar = false` 且
 * 关键词没命中（默认口径）时语义分记 0。
 *
 * **`wish.category IS NULL`（不限分类）**：M4 起默认 `satisfied` —— 分类约束天然满足，
 * category 分项按 100 计入四路加权和（"不限分类"不再因为分项记 0 而被摊薄）。M3 的
 * `renormalize`（跳过 category 分项、把权重摊到其余三项）保留为可选口径，只用于对照实验：
 * 它会让不限分类的愿望系统性低分——`cal-unlimited-phone` 在 v1 拿 100 分、在 v2
 * `renormalize` 下只有 58 分，即"语义接入后本来能成的对反而失配"。v1 分支（`semantic === null`）
 * 保持 #8 冻结的 renormalize 规则不变。
 */
export function scoreMatchWithWeights(
  listing: MatchListingFacts,
  wish: MatchWishFacts,
  semantic: MatchSemanticInput | null,
  weights: RankingWeights,
  params: ScoringParams = DEFAULT_SCORING_PARAMS,
): MatchScoreBreakdown {
  const keyword = keywordScore(listing, wish.keyword)
  const price = priceScore(listing, wish.budgetMaxCents)
  const category = categoryScore(listing, wish.category)
  // 不限分类的两种口径：`satisfied` 时分类项按 100 计入（约束天然满足），否则按实际值 0。
  const effectiveCategory =
    wish.category === null && params.nullCategoryMode === 'satisfied' ? 100 : category

  if (semantic === null) {
    const raw =
      wish.category === null
        ? (WEIGHTS_V1.keyword * keyword + WEIGHTS_V1.price * price) / WEIGHTS_V1_WITHOUT_CATEGORY
        : WEIGHTS_V1.category * category + WEIGHTS_V1.keyword * keyword + WEIGHTS_V1.price * price

    return {
      score: Math.round(raw),
      categoryScore: category,
      keywordScore: keyword,
      priceScore: price,
      semanticScore: null,
      rankingVersion: RANKING_VERSION_V1,
    }
  }

  const semanticRaw = normalizeSimilarity(
    semantic.similarity,
    params.semanticFloor,
    params.semanticCeiling,
  )
  const semanticScore = semanticAllowed(wish, keyword, category, params) ? semanticRaw : 0

  const raw =
    wish.category === null && params.nullCategoryMode === 'renormalize'
      ? (weights.semantic * semanticScore + weights.keyword * keyword + weights.price * price) /
        (weights.semantic + weights.keyword + weights.price)
      : weights.semantic * semanticScore +
        weights.category * effectiveCategory +
        weights.keyword * keyword +
        weights.price * price

  return {
    score: Math.round(raw),
    categoryScore: effectiveCategory,
    keywordScore: keyword,
    priceScore: price,
    semanticScore,
    rankingVersion: RANKING_VERSION,
  }
}

/** 生产入口：v2 权重已冻结，engine 只调用这一个函数（`semantic === null` 自动退回 v1）。 */
export function scoreMatch(
  listing: MatchListingFacts,
  wish: MatchWishFacts,
  semantic: MatchSemanticInput | null,
): MatchScoreBreakdown {
  return scoreMatchWithWeights(listing, wish, semantic, WEIGHTS_V2)
}
