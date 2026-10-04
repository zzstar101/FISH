import { z } from 'zod'
import { INTEREST_ACTION_WEIGHTS } from './interest'
import type { RecommendationEventType } from './schema'

/**
 * Rule-based Ranking 契约（Issue #323 / R4 — Rule-based Ranking & Re-ranking）。
 *
 * 这里只放**没有 IO 的常量与纯计算**：策略版本串、排序特征键与权重、归一化口径、重排约束、
 * 快照上限。四个调用方共用同一份数值，因此"同输入 + 同 `RANK_STRATEGY_VERSION` ⇒ 同排序结果"
 * 是可证的：
 *
 * - `apps/api`：请求时算 `rankScore` + 重排 + 落快照（`recommendation_request_items`）；
 * - 测试 fixture：用同一份常量钉住权重与约束，不写第二套数字；
 * - R6 的离线评估：按这里的键读快照里的 `rank_breakdown`，不再解析字符串；
 * - 将来的 ML ranker：替换 `score.ts` 的实现即可，版本号与明细形状不动。
 *
 * **M4 的公式不在这里**：契约给的是"零件"（特征键、权重、归一化），不是那个表达式。
 * `priceAffinity` 与 `quality` 两项在 v1 **刻意缺席**（候选集里没有价格与质量列，加它们要动召回层），
 * 所以 `rankScore` 不能按 M4 的字面公式复现——这一点写进设计文档的「已知边界」而不是偷偷补齐。
 */

/**
 * 排序策略版本。**权重表、归一化口径、特征键集合**任一改动都要升版本。
 *
 * 与 `INTEREST_STRATEGY_VERSION`（画像怎么算）/ `RECALL_STRATEGY_VERSION`（候选怎么召回）分开：
 * 三者可以独立演进。它最终作为一段拼进 `recommendation_requests.strategy_version` 的复合串，
 * 所以"线上这批结果出自哪一版排序"永远可判（M4 要求②）。
 */
export const RANK_STRATEGY_VERSION = 'rank-v1'

/**
 * M4 建议的对外总版本名：v1 的排序是规则排序，不是模型排序。
 *
 * 复合串的**第一段**固定是它；将来换成模型排序时这一段变成 `rec-v2-model` 之类，
 * 而后面几段（画像/召回/排序）的版本号可以各自继续走。
 */
export const RECOMMENDATION_STRATEGY_VERSION_RULE = 'rec-v1-rule'

/** 复合版本串的分隔符。 */
export const RECOMMENDATION_STRATEGY_VERSION_SEPARATOR = '+'

/**
 * 复合策略版本：`rec-v1-rule+interest-v1+recall-v1+rank-v1`。
 *
 * 为什么是**单列复合串**而不是加几列：`strategy_version` 已经是 `varchar(64)`，而这段串
 * 41 个字符（实测 `rec-v1-rule+interest-v1+recall-v1+rank-v1`.length）；加列意味着改表 + 改
 * 索引 + 改所有读取方，换来的只是"能按段过滤"——但没有人会
 * 按"召回版本"筛请求行，出问题时看的是整串。客户端把它当**不透明字符串**，不解析。
 *
 * **永远带全部段**，即使本次是冷启动（无 session / 无长期画像）：版本标识的是**流水线**，
 * 不是"这次有没有数据"。冷启动是同一版本下的一条分支；用另一个版本串会让"同输入同版本可复现"
 * 这条不变式失效（同一份输入会因为"用户今天恰好没有行为"而被记成两版）。
 *
 * 降级时**不走这里**：直接写 R1 的 `RECOMMENDATION_STRATEGY_VERSION_NONE`（`rec-v1-none`），
 * 因为那条路径根本没跑召回与排序。
 */
export function composeRecommendationStrategyVersion(parts: readonly string[]): string {
  return parts.join(RECOMMENDATION_STRATEGY_VERSION_SEPARATOR)
}

/**
 * 排序特征键（M4 公式里的每一项对应一个键）。
 *
 * 两个惩罚项也是**特征**而不是特例：它们和正特征一样进 `rank_breakdown`，只是权重为负。
 * 这样"某条商品为什么排在后面"永远能用同一套结构回答，不用为惩罚另写一段解释逻辑。
 */
export const RankFeatureKeySchema = z.enum([
  /** M4 `semanticAffinity`：兴趣向量与商品向量的余弦相似度。 */
  'semantic',
  /** M4 `wishAffinity`：#322 愿望匹配分。 */
  'wish',
  /** M4 `categoryAffinity`：会话类目兴趣的归一化强度。 */
  'category',
  /** M4 `freshness`：商品年龄的指数衰减。 */
  'freshness',
  /** M4 `popularity`：14 天加权互动热度。 */
  'popularity',
  /** M4 `repeatedExposurePenalty`：已曝光次数（负权）。 */
  'repeatedExposure',
  /** M4 `negativeFeedbackPenalty`：类目/卖家级负反馈（负权）。 */
  'negativeFeedback',
])

export type RankFeatureKey = z.infer<typeof RankFeatureKeySchema>

/**
 * 特征键的**固定遍历顺序**。
 *
 * 排序层按这个顺序累加 `contribution`：浮点加法不满足结合律，遍历顺序变了末位就可能不同，
 * 而"同输入同结果"（M4 要求④ + M8 可复现）要求逐位相同。
 */
export const RANK_FEATURE_KEYS = RankFeatureKeySchema.options

/**
 * v1 权重初值（**拍的**，没有任何线上数据支撑，靠 R6 的离线评估与 A/B 迭代）。
 *
 * - 正权重和恰好 `1.00`：`rankScore` 的上界因此是确定的 `1.00`，不是"随特征数漂移"。
 *   加一项正特征就必须从别处减，否则上界悄悄变了、跨版本的分数不再可比。
 * - `semantic` 最重（0.35）：兴趣向量是唯一"跨类目、按语义"的个性化信号。
 * - `category` 次之（0.20）：比 semantic 粗，但冷启动时它是唯一可用的个性化信号。
 * - `wish` / `freshness` / `popularity` 各 0.15：wish 精准但覆盖极窄（有愿望的商品很少），
 *   freshness 与 popularity 是**非个性化**的兜底信号，给太高会把首页变成"最新/最热"。
 * - `repeatedExposure: -0.20`：重复曝光是"我已经看过"的负证据，但它不该压过真实兴趣——
 *   一件我很喜欢的商品被推第二次，仍然应该排在没兴趣的新商品前面。
 * - `negativeFeedback: -0.30`：比重复曝光更重（明确划走/隐藏是主动表态），但仍是**软惩罚**：
 *   listing 级硬排除由 `RANK_HIDDEN_EVENT_TYPES` 负责，不靠把权重调到 -1。
 *
 * 改动这里必须同时改 `RANK_STRATEGY_VERSION`，否则历史快照里的分数无法解释。
 */
export const RANK_FEATURE_WEIGHTS: Record<RankFeatureKey, number> = {
  semantic: 0.35,
  category: 0.2,
  wish: 0.15,
  freshness: 0.15,
  popularity: 0.15,
  repeatedExposure: -0.2,
  negativeFeedback: -0.3,
}

/** 正权重之和（= 1.00）。测试钉住它，防止加特征时悄悄改了 `rankScore` 的上界。 */
export const RANK_POSITIVE_WEIGHT_SUM = RANK_FEATURE_KEYS.filter(
  (key) => RANK_FEATURE_WEIGHTS[key] > 0,
).reduce((sum, key) => sum + RANK_FEATURE_WEIGHTS[key], 0)

/**
 * `wishScore` 的满分。`matches.score` 是 `integer` 且有 `score >= 0 AND score <= 100` 的 CHECK
 * （`packages/db/src/schema/matches.ts`），所以归一化就是除以它。
 *
 * 放在契约里而不是写 `/ 100`：量纲变了（比如将来换成 0–1）必须是一次显式改动。
 */
export const RANK_WISH_SCORE_MAX = 100

/** 热度半饱和点：`p / (p + K)`，14 天加权互动数到 5 就吃掉一半权重。 */
export const RANK_POPULARITY_HALF_SATURATION = 5

/** 重复曝光半饱和点：已曝过 2 次吃掉一半惩罚。 */
export const RANK_REPEATED_EXPOSURE_HALF_SATURATION = 2

/** 负反馈半饱和点：累计权重到 2 吃掉一半惩罚。 */
export const RANK_NEGATIVE_FEEDBACK_HALF_SATURATION = 2

/**
 * 触发**类目/卖家级软惩罚**的事件类型（D15）。
 *
 * 权重取 `|INTEREST_ACTION_WEIGHTS[t]|`（HIDE 3 / UNFAVORITE 2 / QUICK_SKIP 0.5），
 * 与 R2 的画像口径同源：同一份"这个行为有多负"只定义一次。
 *
 * 为什么 `IMPRESSION` 不在里面：曝光不是负反馈（`INTEREST_ACTION_WEIGHTS.IMPRESSION = 0`），
 * 它由 `repeatedExposure` 单独处理——那是"重复"，不是"讨厌"。
 */
export const RANK_NEGATIVE_FEEDBACK_EVENT_TYPES = [
  'HIDE',
  'UNFAVORITE',
  'QUICK_SKIP',
] as const satisfies readonly RecommendationEventType[]

/**
 * 触发 **listing 级硬排除**的事件类型（M6「已划走/隐藏的内容不重复推荐」）。
 *
 * 只有 `HIDE`：它是用户对**这一件商品**的明确拒绝。`QUICK_SKIP` 不能硬排除（阈值 1000ms 的
 * 划过太容易误判成"不想要"，把误判做成硬排除等于永久少推一件商品），`UNFAVORITE` 只在
 * 收藏过的商品上可能发生，本来就少见。
 *
 * 时间窗与 `RANK_NEGATIVE_FEEDBACK_EVENT_TYPES` 相同（R2 的 `interestLookbackStart(now)` =
 * 180 天），与小程序端本地隐藏名单的 180 天 TTL 对齐。
 */
export const RANK_HIDDEN_EVENT_TYPES = [
  'HIDE',
] as const satisfies readonly RecommendationEventType[]

/**
 * 触发**重复曝光冷却**的归因曝光次数（M6「同一个商品反复曝光但用户持续不点：降权；达到阈值后
 * 短期冷却」）。
 *
 * 软惩罚（`repeatedExposure` 特征）与冷却是两件事，不是同一个旋钮的两个档位：
 *
 * - 软惩罚回答"还值不值得排在前面"，只减分，永远排得出去（2 次半饱和 ⇒ 5 次时惩罚已近 0.71）；
 * - 冷却回答"这一轮要不要干脆别发了"，是**硬排除**，且**会自己结束**（见
 *   `RANK_REPEATED_EXPOSURE_COOLDOWN_MS`）。
 *
 * 3 次的依据：`RANK_REPEATED_EXPOSURE_HALF_SATURATION = 2` 时，2 次曝光的软惩罚已到 0.5，
 * 但"曝过 2 次没点"在翻页场景里很常见（用户翻过一屏、没细看），把它硬排除会误伤；到 3 次还
 * 一次都没点开，才够得上"反复推给他、他持续不点"。
 */
export const RANK_REPEATED_EXPOSURE_COOLDOWN_THRESHOLD = 3

/**
 * 冷却时长：自**最后一次归因曝光**起算 24 小时（M6 的"短期"）。
 *
 * 为什么从最后一次曝光起算而不是从"第一次达到阈值"起算：用户每被推一次就续期一次，这样"一直
 * 在被推"的商品才会一直在冷却里；一旦停了 24 小时，说明它已经不在用户视野里，放出来重新试一次
 * 比继续压着更有信息量。
 *
 * 24 小时是"一个自然日"：校园二手的浏览节奏按天走，短于一天会让当天晚些时候的翻页又看到同一件
 * 商品（用户感知就是"它怎么又来了"），长于一天则会把真正可能被点开的商品压太久。
 */
export const RANK_REPEATED_EXPOSURE_COOLDOWN_MS = 24 * 60 * 60 * 1_000

/**
 * 冷却的**解除条件**之一：用户在窗口内对这件商品有过这些行为里的任何一个，就不算"持续不点"，
 * 不适用冷却（`DETAIL_VIEW` 及以上）。
 *
 * 与 `RANK_EVAL_RELEVANCE_GRADES` 里分级 ≥ 1 的集合一致（`rank.test.ts` 有一条用例钉住这个
 * 不变式）："用户点过"这件事在线上冷却与离线评估里必须是同一个集合，否则会出现"离线算他点过、
 * 线上算他没点"这种两边都说自己对的漂移。
 *
 * 刻意**不**包含 `QUICK_SKIP`：那是"划过"，不是"点过"。
 */
export const RANK_COOLDOWN_ENGAGEMENT_EVENT_TYPES = [
  'DETAIL_VIEW',
  'FAVORITE',
  'CHAT_START',
  'COMMENT',
  'TRANSACTION_START',
  'PURCHASE',
] as const satisfies readonly RecommendationEventType[]

/**
 * 冷却的**豁免条件**：命中 `wish` 召回通道的候选不进冷却（M6「用户主动再次搜索 / Wish 命中时
 * 允许重新进入」）。
 *
 * 愿望匹配是用户自己表达过的明确需求，比"算法觉得他可能想看"强得多；用冷却把它压掉，用户会看到
 * "我明明想要这个，首页却从来不给我"。
 */
export const RANK_COOLDOWN_EXEMPT_RECALL_SOURCE = 'wish'

/**
 * 饱和变换：`value / (value + K)`，`value >= 0` 时值域 `[0, 1)`。
 *
 * 为什么不用 min-max（除以候选集最大值）：**候选集相关的归一化会让同一件商品在不同候选集里
 * 得分不同**，于是"同 requestId 重放得到同一结果"不成立，R6 的离线回放也就没法做。
 * 饱和变换只依赖特征自身的量纲，与谁跟它同场竞争无关。
 *
 * 非法输入（`NaN` / 负值 / 非有限值）一律返回 0：这些值只可能来自上游查询异常，
 * 让它们变成 0 是"没有这个信号"，比让 `NaN` 传播进排序（比较函数全返回 false，顺序静默错乱）安全。
 */
export function saturatingRatio(value: number, halfSaturation: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return value / (value + halfSaturation)
}

/**
 * 截断到 `[0, 1]`。
 *
 * `semanticScore` 是 `1 − 余弦距离`，理论上可以落到负数（距离 >1）；负相似度没有"负贡献"的
 * 语义，截到 0 而不是让它去减分——否则"semanticScore = −1 + 满分类目"这种组合会得出一个
 * 无法解释的低分。
 */
export function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  if (value >= 1) return 1
  return value
}

/** 同一卖家两次出现之间的最小间隔（位）：`2` = 中间至少隔 1 件别的商品。 */
export const RERANK_SELLER_MIN_GAP = 2

/** 同类目滑动窗口长度（位）。 */
export const RERANK_CATEGORY_WINDOW = 3

/** 同类目在窗口内的最大条数：任意连续 3 位里同类目 ≤2 条。 */
export const RERANK_CATEGORY_MAX_IN_WINDOW = 2

/** 探索配额窗口长度（位）。 */
export const RERANK_EXPLORE_WINDOW = 5

/** 每个探索窗口内至少几条来自 `explore` 通道 ⇒ 探索占比 ≥20%。 */
export const RERANK_EXPLORE_MIN_PER_WINDOW = 1

/** 可被松弛的约束。 */
export const RerankConstraintSchema = z.enum(['seller', 'category', 'explore'])

export type RerankConstraint = z.infer<typeof RerankConstraintSchema>

/**
 * 固定松弛顺序：先让探索配额，再让类目窗，最后才让卖家间隔。
 *
 * 顺序即优先级，理由是三类约束的**性质不同**：探索配额是平台目标（给新商品/新卖家曝光），
 * 让掉只是这一页少一点探索，用户感知不到；类目窗是体验约束，让掉会让同类目连出；
 * 卖家间隔最接近"霸屏"（同一卖家的商品占满首页），是三者里最不能破的。
 *
 * **不引入随机**：约束不满足时按这个顺序逐个让掉并计数，结果与"谁来跑"无关。
 */
export const RERANK_RELAXATION_ORDER = [
  'explore',
  'category',
  'seller',
] as const satisfies readonly RerankConstraint[]

/**
 * 一个推荐请求最多落多少行快照（N1）。
 *
 * 一个 `requestId` 可被反复翻页，不设上限时一次滚动能写出无界行；正常单页 ≤50
 * （`RecommendationFeedQuerySchema` 的 `limit` 上限），200 只为挡住异常长滚。
 * 超上限即 `nextCursor = null`。
 */
export const RECOMMENDATION_SNAPSHOT_MAX_ITEMS = 200

/**
 * 逐特征明细里的一项。
 *
 * `contribution` 是**落库的值**（不是读取时重算）：`normalized * weight`。存下来而不是让
 * 读取方乘，是为了让"历史分数"永远等于当时的算法——权重表将来改了，旧快照仍然自洽。
 */
export const RankFeatureContributionSchema = z.strictObject({
  /** 归一化后的特征值，恒在 `[0, 1]`。 */
  normalized: z.number().min(0).max(1),
  weight: z.number(),
  contribution: z.number(),
})

export type RankFeatureContribution = z.infer<typeof RankFeatureContributionSchema>

/**
 * 一条快照行的排序明细（`recommendation_request_items.rank_breakdown`）。
 *
 * **七个键全在**（`strictObject` 强制）：某个特征这次没有值（冷启动无 semantic、曝光次数读取
 * 失败）时，它的 `normalized` 是 0 并进 `missing` —— "未知"与"真的是 0"必须能区分。
 * R3 §9 待办① 说的就是这个：`alreadySeenCount` 查询失败时静默变 0，等于把"不知道"当成
 * "一次都没看过"，于是少给了一次惩罚却看不出来。
 *
 * 为什么用 `missing: string[]` 而不是给每项加一个 `input` 字段：明细的用途是"解释分数"，
 * 原始输入值（曝光 3 次、热度 12）在排查时确实有用，但那是**另一个问题**——存原始值会让
 * `rank_breakdown` 体积翻倍，而 `missing` 只要几个字符串就能回答"这项参与了吗"。
 */
export const RankScoreBreakdownSchema = z.strictObject({
  semantic: RankFeatureContributionSchema,
  wish: RankFeatureContributionSchema,
  category: RankFeatureContributionSchema,
  freshness: RankFeatureContributionSchema,
  popularity: RankFeatureContributionSchema,
  repeatedExposure: RankFeatureContributionSchema,
  negativeFeedback: RankFeatureContributionSchema,
  /** 这次没有值（不是 0）的特征键。 */
  missing: z.array(RankFeatureKeySchema),
})

export type RankScoreBreakdown = z.infer<typeof RankScoreBreakdownSchema>

/** 负反馈软惩罚用的行为权重（`|INTEREST_ACTION_WEIGHTS|`）。 */
export const RANK_NEGATIVE_FEEDBACK_WEIGHTS: Record<
  (typeof RANK_NEGATIVE_FEEDBACK_EVENT_TYPES)[number],
  number
> = {
  HIDE: Math.abs(INTEREST_ACTION_WEIGHTS.HIDE),
  UNFAVORITE: Math.abs(INTEREST_ACTION_WEIGHTS.UNFAVORITE),
  QUICK_SKIP: Math.abs(INTEREST_ACTION_WEIGHTS.QUICK_SKIP),
}
