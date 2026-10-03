/**
 * 规则排序打分（#323 R4 / M4）。
 *
 * 纯函数：输入是 R3 的候选集 + 负反馈信号，输出每条候选的 `rankScore` 与**逐特征明细**。
 * 不查库、不读时钟、不调模型 —— 同一个候选集在任何时刻、任何机器上都得到同一个分数。这是
 * "可解释 + 可复现 + 后续可换成 ML"的前提：换模型只是换这个函数，管线其余部分不动。
 *
 * 归一化刻意**与候选集无关**（固定饱和变换，不是 min-max）：候选集一变分数就全变，会导致
 * 翻页时同一商品在两页里得分不同、跨请求不可比，也会让离线评估无法归因。
 */

import {
  clamp01,
  RANK_FEATURE_KEYS,
  RANK_FEATURE_WEIGHTS,
  RANK_POPULARITY_HALF_SATURATION,
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

function buildBreakdown(
  candidate: RecallCandidate,
  feedback: NegativeFeedbackSignals | null,
): RankScoreBreakdown {
  const breakdown = {} as Record<RankFeatureKey, RankFeatureContribution>
  const missing: RankFeatureKey[] = []

  for (const feature of RANK_FEATURE_KEYS) {
    const weight = RANK_FEATURE_WEIGHTS[feature]
    const normalized = normalizeFeature(candidate, feature, feedback)
    if (normalized === null) missing.push(feature)
    // 缺失特征按 0 参与求和（而不是跳过）：明细的形状固定，离线评估才能按 key 对齐比较。
    const value = normalized ?? 0
    breakdown[feature] = { normalized: value, weight, contribution: value * weight }
  }

  return { ...breakdown, missing }
}

export function scoreCandidates(input: {
  candidates: readonly RecallCandidate[]
  feedback: NegativeFeedbackSignals | null
}): ScoredCandidate[] {
  return input.candidates
    .map((candidate) => {
      const breakdown = buildBreakdown(candidate, input.feedback)
      let rankScore = 0
      // 按 `RANK_FEATURE_KEYS` 的固定顺序累加：浮点加法不满足结合律，顺序一变末位就变。
      for (const feature of RANK_FEATURE_KEYS) rankScore += breakdown[feature].contribution
      return { candidate, rankScore, breakdown }
    })
    .sort(compareScoredCandidates)
}
