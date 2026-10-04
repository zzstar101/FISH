import { describe, expect, test } from 'bun:test'
import {
  evaluateVisualEvalGates,
  VISUAL_EVAL_HYBRID_MAX_INVERSIONS,
  VISUAL_EVAL_MIN_SAMPLE_COUNT,
  type VisualEvalGateInput,
} from './gates'

/**
 * 门槛本身的单测（#406 第 3 项）。
 *
 * 这里钉两件事：
 * 1. **门槛表与当前实测值相容**：`current()` 是 `bun run visual:eval` 在 21 条样本上的输出
 *    **手工抄录**（MRR 0.833/0.976/1.000、NDCG@10 0.855/0.959/0.993、首选命中 12/19/21、
 *    排序倒置 9/5/3）。它**不**从 fixture 现算，所以它防的是"阈值表被改坏/与实测值脱节"，
 *    **防不了 fixture 漂移**——fixture 一改这条用例照绿。fixture 漂移由 CI 的
 *    `bun run visual:eval`（第五节门槛表决定退出码）与 `ranking.test.ts` 里那条从
 *    `VISUAL_EVAL_FIXTURE` 现算的回归护栏负责。
 * 2. **退化输入必须真的被判红**——否则"门槛"只是打印出来好看。特别是"三路打平"这种
 *    最隐蔽的失效（报告全绿但 fixture 已经失去分辨力）。
 */
function current(): VisualEvalGateInput {
  return {
    sampleCount: 21,
    paths: {
      'visual-only': { hits: 12, inversions: 9, mrr: 0.833, ndcgAt10: 0.855 },
      'text-only': { hits: 19, inversions: 5, mrr: 0.976, ndcgAt10: 0.959 },
      hybrid: { hits: 21, inversions: 3, mrr: 1, ndcgAt10: 0.993 },
    },
  }
}

function gateNames(input: VisualEvalGateInput): string[] {
  return evaluateVisualEvalGates(input).map((violation) => violation.gate)
}

describe('evaluateVisualEvalGates', () => {
  test('手工抄录的当前实测值不被门槛表判红', () => {
    expect(evaluateVisualEvalGates(current())).toEqual([])
  })

  test('hybrid 的绝对下限：MRR 掉到 0.9 判红', () => {
    const input = current()
    input.paths.hybrid.mrr = 0.9

    expect(gateNames(input)).toContain('hybrid MRR 下限')
  })

  test('hybrid 的绝对下限：NDCG@10 掉到 0.8 判红', () => {
    const input = current()
    input.paths.hybrid.ndcgAt10 = 0.8

    expect(gateNames(input)).toContain('hybrid NDCG@10 下限')
  })

  test('hybrid 的绝对下限：首选命中率掉到 50% 判红', () => {
    const input = current()
    input.paths.hybrid.hits = 10

    expect(gateNames(input)).toContain('hybrid 首选命中率下限')
  })

  test('hybrid 的绝对下限：排序倒置超过上限判红', () => {
    const input = current()
    input.paths.hybrid.inversions = VISUAL_EVAL_HYBRID_MAX_INVERSIONS + 1

    expect(gateNames(input)).toContain('hybrid 排序倒置上限')
  })

  test('相对优势：hybrid 与单路打平也要判红（"三路同分"= fixture 失去分辨力）', () => {
    const input = current()
    // 首选命中与 text-only 打平，MRR/NDCG 也压到同一水平。
    input.paths.hybrid = { hits: 19, inversions: 5, mrr: 0.976, ndcgAt10: 0.959 }

    const gates = gateNames(input)
    expect(gates).toContain('hybrid > text-only 首选命中')
    expect(gates).toContain('hybrid > text-only MRR')
    expect(gates).toContain('hybrid < text-only 排序倒置')
  })

  test('相对优势：hybrid 弱于 visual-only 时逐项判红', () => {
    const input = current()
    input.paths.hybrid = { hits: 11, inversions: 10, mrr: 0.8, ndcgAt10: 0.85 }

    const gates = gateNames(input)
    expect(gates).toContain('hybrid > visual-only 首选命中')
    expect(gates).toContain('hybrid > visual-only MRR')
    expect(gates).toContain('hybrid > visual-only NDCG@10')
    expect(gates).toContain('hybrid < visual-only 排序倒置')
  })

  test('样本数被删到不足以支撑结论时判红', () => {
    const input = current()
    input.sampleCount = VISUAL_EVAL_MIN_SAMPLE_COUNT - 1

    expect(gateNames(input)).toContain('样本数')
  })

  test('缺少 hybrid 路时判红并立即返回（没有可判的对象）', () => {
    const input = current()
    // 故意构造缺失：门槛必须报出来，而不是把 undefined 当 0 继续比。
    delete (input.paths as Partial<VisualEvalGateInput['paths']>).hybrid

    expect(gateNames(input)).toEqual(['路径缺失'])
  })
})
