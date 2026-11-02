/**
 * 规则排序打分（#323 R4 / M4）。
 *
 * 纯函数：输入是 R3 的候选集 + 负反馈信号，输出每条候选的 `rankScore` 与**逐特征明细**。
 * 不查库、不读时钟、不调模型 —— 同一个候选集在任何时刻、任何机器上都得到同一个分数。这是
 * "可解释 + 可复现 + 后续可换成 ML"的前提：换模型只是换这个函数，管线其余部分不动。
 *
 * 归一化刻意**与候选集无关**（固定饱和变换，不是 min-max）：候选集一变分数就全变，会导致
 * 跨请求不可比，也会让离线评估无法归因。唯一依赖候选集的是缺失处理（#524，见 `planFeatures`）：
 * 整列缺失的特征去权重并重归一化，个别缺失按请求均值填 —— 都只发生在"没有值"的格子上。
 */

import {
  clamp01,
  RANK_FEATURE_KEYS,
  RANK_FEATURE_WEIGHTS,
  RANK_POPULARITY_HALF_SATURATION,
  RANK_POSITIVE_WEIGHT_SUM,
  RANK_REPEATED_EXPOSURE_HALF_SATURATION,
  RANK_WISH_SCORE_MAX,
  type RankFeatureContribution,
  type RankFeatureKey,
  type RankScoreBreakdown,
  saturatingRatio,
} from '@fish/contracts/recommendation/rank'
import type { RecallCandidate } from '../recall/types'
import { type NegativeFeedbackSignals, pickNegativeFeedback } from './feedback'

export type ScoredCandidate = {
  candidate: RecallCandidate
  rankScore: number
  breakdown: RankScoreBreakdown
}

/**
 * `rankScore` 降序；分数相同按 `listingId` 升序。
 *
 * 必须有确定的次级排序键：浮点分数撞车在候选只有几百条时并不罕见（例如两条都没有任何行为
 * 信号的冷启动候选得分完全相同），只按分数排的 `sort` 在不同引擎实现下顺序可以不同，快照
 * 就会在同一份输入上写出不同的 position。
 */
export function compareScoredCandidates(a: ScoredCandidate, b: ScoredCandidate): number {
  if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore
  if (a.candidate.listingId < b.candidate.listingId) return -1
  if (a.candidate.listingId > b.candidate.listingId) return 1
  return 0
}

/** 特征原值 → `[0, 1]`。返回 `null` 表示**这个特征没有值**（区别于"值为 0"）。 */
function normalizeFeature(
  candidate: RecallCandidate,
  feature: RankFeatureKey,
  feedback: NegativeFeedbackSignals | null,
): number | null {
  switch (feature) {
    case 'semantic':
      // 余弦相似度 `1 - distance`，理论上可能落到负数（完全相反的方向）→ clamp 到 0。
      return candidate.semanticScore === null ? null : clamp01(candidate.semanticScore)
    case 'wish':
      // `matches.score` 是 integer 0–100（DB 侧 CHECK），不是 0–1。
      return candidate.wishScore === null
        ? null
        : clamp01(candidate.wishScore / RANK_WISH_SCORE_MAX)
    case 'category':
      // R3 合并时已归一化到 0–1，且负权重类目已被剔除。
      return candidate.userCategoryAffinity === null
        ? null
        : clamp01(candidate.userCategoryAffinity)
    case 'freshness':
      // R3 的 `freshnessOf` 恒为 0.5 的幂，永远有值。
      return clamp01(candidate.freshness)
    case 'popularity':
      return candidate.popularity === null
        ? null
        : saturatingRatio(candidate.popularity, RANK_POPULARITY_HALF_SATURATION)
    case 'repeatedExposure':
      // R3 待办①：`null` = 曝光计数查询失败（未知），0 = 确实没重复曝光。两者不能混为一谈。
      return candidate.alreadySeenCount === null
        ? null
        : saturatingRatio(candidate.alreadySeenCount, RANK_REPEATED_EXPOSURE_HALF_SATURATION)
    case 'negativeFeedback':
      // `feedback === null` = 负反馈查询失败或无身份 ⇒ 这一项未知，而不是"没有负反馈"。
      return feedback === null ? null : pickNegativeFeedback(feedback, candidate)
  }
}

/**
 * 请求级的特征口径（#524）：每个特征在**本次候选集**上是整列缺失、部分缺失还是齐全。
 *
 * - **整列缺失**（请求级不可用：匿名没有愿望、没有兴趣向量、没有类目行为、负反馈查询失败…）
 *   ⇒ 该特征权重记 0，其余**正**权重按比例放大回 `RANK_POSITIVE_WEIGHT_SUM`。v1 把缺失当 0
 *   参与求和，冷启动用户的分数上界只有 0.65，而且同一份候选里"有值的特征"与"缺的特征"混在
 *   一起，分数没法比；重归一化后，任何请求的正向部分都在同一个 `[0, 1]` 尺度上。负权重（两个
 *   惩罚项）不参与放大：惩罚的力度不应因为别的特征缺失而变大。
 * - **部分缺失**（候选级：某件商品没有当前模型的向量）⇒ 用本次请求里该特征的**均值**填，
 *   既不奖励也不惩罚"缺数据"的商品。
 *
 * 两种缺失都记进该候选 `breakdown.missing`，`weight` 写本次实际生效的权重。
 */
type FeaturePlan = {
  weights: Record<RankFeatureKey, number>
  /** 部分缺失特征的填充值（请求均值）；整列缺失的特征不在此表。 */
  fill: Map<RankFeatureKey, number>
}

function planFeatures(rows: readonly (readonly (number | null)[])[]): FeaturePlan {
  const weights = {} as Record<RankFeatureKey, number>
  const fill = new Map<RankFeatureKey, number>()
  let availablePositive = 0

  RANK_FEATURE_KEYS.forEach((feature, column) => {
    let sum = 0
    let count = 0
    for (const row of rows) {
      const value = row[column]
      if (value === null || value === undefined) continue
      sum += value
      count += 1
    }
    const base = RANK_FEATURE_WEIGHTS[feature]
    if (count === 0) {
      weights[feature] = 0
      return
    }
    weights[feature] = base
    if (base > 0) availablePositive += base
    if (count < rows.length) fill.set(feature, sum / count)
  })

  const scale = availablePositive > 0 ? RANK_POSITIVE_WEIGHT_SUM / availablePositive : 1
  for (const feature of RANK_FEATURE_KEYS) {
    if (weights[feature] > 0) weights[feature] *= scale
  }
  return { weights, fill }
}

function buildBreakdown(values: readonly (number | null)[], plan: FeaturePlan): RankScoreBreakdown {
  const breakdown = {} as Record<RankFeatureKey, RankFeatureContribution>
  const missing: RankFeatureKey[] = []

  RANK_FEATURE_KEYS.forEach((feature, column) => {
    const weight = plan.weights[feature]
    const raw = values[column] ?? null
    if (raw === null) missing.push(feature)
    // 明细形状固定（七个键全在）：离线评估按 key 对齐比较。整列缺失时 weight = 0、贡献为 0。
    const value = raw ?? plan.fill.get(feature) ?? 0
    breakdown[feature] = { normalized: value, weight, contribution: value * weight }
  })

  return { ...breakdown, missing }
}

export function scoreCandidates(input: {
  candidates: readonly RecallCandidate[]
  feedback: NegativeFeedbackSignals | null
}): ScoredCandidate[] {
  const rows = input.candidates.map((candidate) =>
    RANK_FEATURE_KEYS.map((feature) => normalizeFeature(candidate, feature, input.feedback)),
  )
  const plan = planFeatures(rows)

  return input.candidates
    .map((candidate, index) => {
      const breakdown = buildBreakdown(rows[index] ?? [], plan)
      let rankScore = 0
      // 按 `RANK_FEATURE_KEYS` 的固定顺序累加：浮点加法不满足结合律，顺序一变末位就变。
      for (const feature of RANK_FEATURE_KEYS) rankScore += breakdown[feature].contribution
      return { candidate, rankScore, breakdown }
    })
    .sort(compareScoredCandidates)
}
