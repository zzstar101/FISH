import { RANK_NEGATIVE_FEEDBACK_EVENT_TYPES } from './rank'
import type { RecommendationEventType } from './schema'

/**
 * 离线评估契约（Issue #323 / R6 §3.1）。
 *
 * 这里只放**没有 IO 的常量与纯计算**，与 `interest.ts` / `rank.ts` 的分工一致：
 * `apps/worker/src/jobs/recommendation/eval.ts` 拿这些常量做计算，`apps/worker/scripts/rank-eval.ts`
 * 只负责取数与打印。契约因此可以进 CI（`--fixture` 模式不连库）。
 *
 * 为什么相关性分级要写成契约常量：**换分级就是换指标定义**。同一批数据在"二值相关"与"分级相关"
 * 下算出的 NDCG 不可比，把 3/2/1 散在脚本里会让"这个数在跟上个月比什么"变成一个需要读代码才能回答的问题。
 */

/**
 * 相关性分级（决策 D6）。
 *
 * 三级而不是二值：二值分级分不出"点了"与"买了"，而只用最强信号（`PURCHASE`）在小体量下样本
 * 极稀疏、没有统计意义。`TRANSACTION_START` 与 `PURCHASE` 同为 3：前者是"发起交易"（HIDE 的
 * 反面），后者是"成交"，中间还隔着线下交割，两个都算最强意图。
 *
 * `DETAIL_VIEW = 1` 是最弱正向信号：它只说明"点开了"，但不点开不可能买，所以不能算噪声。
 */
export const RANK_EVAL_RELEVANCE_GRADES = {
  PURCHASE: 3,
  TRANSACTION_START: 3,
  CHAT_START: 2,
  COMMENT: 2,
  FAVORITE: 2,
  DETAIL_VIEW: 1,
} as const satisfies Partial<Record<RecommendationEventType, number>>

export type RankEvalRelevantEventType = keyof typeof RANK_EVAL_RELEVANCE_GRADES

/**
 * 命中这些事件就把商品从相关集里**剔除**（不是记负分）：NDCG 的增益 `2^grade − 1` 在负 grade 上
 * 没有定义，而"把负信号也算进相关集再给 0 增益"等价于把 `HIDE` 当成"看过但没兴趣"，比剔除更松。
 *
 * **复用排序层的 `RANK_NEGATIVE_FEEDBACK_EVENT_TYPES`**（HIDE / UNFAVORITE / QUICK_SKIP）而不是
 * 另写一份：同一份"这个行为有多负"只定义一次，否则评估口径会和线上惩罚漂移
 * （线上加了新的负反馈事件、评估却还在数旧的，指标会突然变好，而那不是排序变好了）。
 */
export const RANK_EVAL_NEGATIVE_EVENT_TYPES = RANK_NEGATIVE_FEEDBACK_EVENT_TYPES

/**
 * 同时报三档 K：5 是一屏内、10 是首屏、20 是默认页大小
 * （`RecommendationFeedQuerySchema` 的 `limit` 默认 20）。
 *
 * 只报一个 K 会让"改 K 之后指标变了"被误读成排序变好/变坏；三档一起看能区分
 * "头部变好"与"长尾变好"。
 */
export const RANK_EVAL_K_VALUES = [5, 10, 20] as const

export type RankEvalK = (typeof RANK_EVAL_K_VALUES)[number]

/**
 * 观察窗默认 7 天（决策 D7）。
 *
 * 上界受两个保留期限制：请求上下文 + 快照 90 天、事件 180 天。窗口越长，被保留期截断的
 * 请求越多（详见设计 §4.4），所以 CLI 必须把实际回放区间与截断提示一起打印出来。
 */
export const RANK_EVAL_DEFAULT_WINDOW_DAYS = 7

/**
 * `freshItemExposure` 里"新"的定义：曝光发生时商品发布 ≤ 7 天。
 *
 * 与 R4/R5 排序特征 `freshness` 的半衰期口径**无关**（那个是连续衰减，这里是计数口径的阈值）：
 * 用同一个数字只是巧合地取了同一个尺度，不构成耦合，所以两者各自有常量。
 */
export const RANK_EVAL_FRESH_ITEM_DAYS = 7

/**
 * 首次曝光归因窗 `W`（设计 §4.3）：事件只能归给「同一身份、快照含该商品、且发生在该请求之后
 * `W` 之内」的请求，取其中最早的一次。
 *
 * 取 30 分钟：一次 Feed 页产生的曝光，其后续行为（点开、收藏、开聊）绝大多数发生在同一个会话内，
 * 而会话以分钟计；窗太长会把"第二天想起来又搜到同一个商品"的行为错记到昨天的推荐上（那会把
 * 指标算得比真实好）。这个值是**口径参数**，改它必须连带说明历史数据不可比。
 */
export const RANK_EVAL_ATTRIBUTION_WINDOW_MS = 30 * 60_000
