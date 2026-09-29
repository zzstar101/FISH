// ---------------------------------------------------------------------------
// #322 M3 离线对比脚本：v1 / semantic-only / 各候选权重组的 hybrid。
//
// 用途（Issue 的 "ranking quality" 验收项）：
//   * 打印每条人工标注样本在 **M2 的 cosine 召回顺序（Top-K）** 里的排名；
//   * 打印 v1、semantic-only 与每组 hybrid 权重的分数、排序、与人工判断的一致性；
//   * 权重组在这里只是被评估，不会改生产行为 —— 生产权重冻结在
//     `apps/worker/src/jobs/matching/scoring.ts` 的 WEIGHTS_V2。
//
// 运行：bun run rank:compare （仓库根目录）或
//       bun run apps/worker/scripts/rank-compare.ts
//
// 注意：样本的 cosine 是人工给定的（见 ranking-fixture.ts），本脚本不出网、
// 不需要 DATABASE_URL；模型语义质量归 M4 的 live smoke。
// ---------------------------------------------------------------------------

import { MATCH_SCORE_THRESHOLD } from '@fish/contracts/matching/schema'
import { RANKING_FIXTURE, type RankingSample } from '../src/jobs/matching/ranking-fixture'
import {
  normalizeSimilarity,
  type RankingWeights,
  SEMANTIC_WEIGHT_CANDIDATES,
  scoreMatch,
  scoreMatchWithWeights,
} from '../src/jobs/matching/scoring'

/**
 * 被评估的权重组：生产里冻结的是 S4，其余三组是对照（拒绝理由见 `scoring.ts` 的注释）。
 */
const SETS: SetEntry[] = Object.entries(SEMANTIC_WEIGHT_CANDIDATES).map(([label, weights]) => ({
  label,
  weights: weights as RankingWeights,
}))

function fixed(value: number, digits = 2): string {
  return value.toFixed(digits)
}

function mark(pass: boolean): string {
  return pass ? '✅' : '❌'
}

function main(): void {
  console.log(
    `人工标注样本：${RANKING_FIXTURE.length} 条；阈值 MATCH_SCORE_THRESHOLD=${MATCH_SCORE_THRESHOLD}`,
  )
  console.log('')

  // ---- 表 1：分数对照 -------------------------------------------------------
  const header = [
    '样本',
    '类别',
    'cos',
    'sem',
    'v1',
    'sem-only',
    ...SETS.map((s) => s.label),
    '人工判断',
  ]
  console.log(`| ${header.join(' | ')} |`)
  console.log(`| ${header.map(() => '---').join(' | ')} |`)
  for (const sample of RANKING_FIXTURE) {
    const scores = evaluate(sample)
    const cells = SETS.map((entry) => {
      const score = scores.hybrid.get(entry.label) ?? 0
      return `${score} ${mark(score >= MATCH_SCORE_THRESHOLD === sample.expectMatch)}`
    })
    console.log(
      [
        sample.id,
        sample.sampleClass,
        fixed(sample.similarity),
        `${scores.normalized} ${mark(scores.normalized >= MATCH_SCORE_THRESHOLD === sample.expectMatch)}`,
        `${scores.v1} ${mark(scores.v1 >= MATCH_SCORE_THRESHOLD === sample.expectMatch)}`,
        `${scores.normalized} ${mark(scores.normalized >= MATCH_SCORE_THRESHOLD === sample.expectMatch)}`,
        ...cells,
        sample.expectMatch ? '匹配' : '不匹配',
      ]
        .map((cell, index) => (index === 0 ? `\`${cell}\`` : cell))
        .join(' | '),
    )
  }
  console.log('')

  // ---- 表 2：与人工判断的一致性 --------------------------------------------
  console.log('### 与人工判断的一致性（误判清单）')
  console.log('')
  for (const entry of SETS) {
    const errors = RANKING_FIXTURE.filter((sample) => {
      const score = evaluate(sample).hybrid.get(entry.label) ?? 0
      return score >= MATCH_SCORE_THRESHOLD !== sample.expectMatch
    })
    const detail = errors.length
      ? errors
          .map((sample) => {
            const score = evaluate(sample).hybrid.get(entry.label) ?? 0
            const verdict = score >= MATCH_SCORE_THRESHOLD ? '误判为匹配' : '漏判'
            const divergence = sample.knownDivergence ? '（已记录为可接受偏差）' : ''
            return `\`${sample.id}\`=${score} ${verdict}${divergence}`
          })
          .join('、')
      : '无'
    console.log(
      `- ${entry.label}：${RANKING_FIXTURE.length - errors.length}/${RANKING_FIXTURE.length} 一致；${detail}`,
    )
  }
  console.log('')

  // ---- 表 3：M2 召回顺序（按 cosine）--------------------------------------
  console.log('### 按 cosine 的召回顺序（M2 Top-K 的顺序）')
  console.log('')
  const byCosine = [...RANKING_FIXTURE].sort((a, b) => b.similarity - a.similarity)
  byCosine.forEach((sample, index) => {
    console.log(
      `${index + 1}. \`${sample.id}\`（${sample.sampleClass}，cos=${fixed(sample.similarity)}）`,
    )
  })
  console.log('')

  // ---- 表 4：hybrid 重新排序的结果 ----------------------------------------
  for (const entry of SETS) {
    console.log(`### ${entry.label} ${describeWeights(entry.weights)} 下的排序`)
    console.log('')
    const ranked = [...RANKING_FIXTURE].sort((a, b) => {
      const left = evaluate(a).hybrid.get(entry.label) ?? 0
      const right = evaluate(b).hybrid.get(entry.label) ?? 0
      if (right !== left) return right - left
      return b.similarity - a.similarity
    })
    ranked.forEach((sample, index) => {
      const score = evaluate(sample).hybrid.get(entry.label) ?? 0
      console.log(
        `${index + 1}. \`${sample.id}\`=${score}${score >= MATCH_SCORE_THRESHOLD ? '（入匹配）' : ''}`,
      )
    })
    console.log('')
  }
}

function describeWeights(weights: RankingWeights): string {
  return `semantic=${weights.semantic} category=${weights.category} keyword=${weights.keyword} price=${weights.price}`
}

type SampleScores = {
  normalized: number
  v1: number
  hybrid: Map<string, number>
}

const CACHE = new Map<string, SampleScores>()

function evaluate(sample: RankingSample): SampleScores {
  const cached = CACHE.get(sample.id)
  if (cached) return cached
  const semantic = { similarity: sample.similarity }
  const scores: SampleScores = {
    normalized: normalizeSimilarity(sample.similarity),
    v1: scoreMatch(sample.listing, sample.wish, null).score,
    hybrid: new Map(
      SETS.map((entry) => [
        entry.label,
        scoreMatchWithWeights(sample.listing, sample.wish, semantic, entry.weights).score,
      ]),
    ),
  }
  CACHE.set(sample.id, scores)
  return scores
}

main()
