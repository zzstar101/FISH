/**
 * #324 M9 离线评测腿的**通过门槛**（#406 第 3 项）。
 *
 * ## 为什么这一层要单独存在
 *
 * `apps/api/scripts/visual-eval.ts` 以前是"只打印、不判定"：任何退化都会得到一份
 * 看起来很正常的 Markdown 报告，退出码恒为 0，CI 里也没有它的位置。于是
 * "三路指标"从来没有被任何人**读过并据此失败过**——这正是 #406 第 3 项记的问题。
 *
 * 把判据放进纯函数（而不是塞在脚本的 `console.log` 之间）有两个实际好处：
 * 一是可以在单测里喂**退化输入**证明它真的会红（否则"门槛"本身没人验证过），
 * 二是脚本只剩"算指标 → 调这里 → 设退出码"，门槛与打印格式各自独立演化。
 *
 * ## 两类门槛，缺一不可
 *
 * 1. **绝对下限**：`hybrid` 的判别性指标不许掉到某个水平以下。这捕捉"排序退化"。
 * 2. **相对优势**：`hybrid` 必须在判别性指标上**严格优于**两条单路基线。
 *    这一条才是本 Issue 真正要验证的命题——"hybrid 同时避开两路各自的失误模式"；
 *    也是 `fixture.ts` 头注释里那条纪律（"三路必须分出高低，否则这个 fixture 什么也证明不了"）
 *    的可执行版本。少了它，某天有人把 fixture 改成三路同分，报告照样一片绿。
 *
 * ## 阈值怎么定的
 *
 * 取 `bun run visual:eval` 在 21 条冻结样本上的**实测值**，并留出余量：
 * `hybrid` MRR 1.000 / NDCG@10 0.993 / 首选命中 21/21 / 排序倒置 3。
 * 余量是给"新增样本"的：加样本必然让指标动，但**动了必须有人看**——
 * 改 fixture 或改权重就要同步复核这张门槛表，并在 PR 里说明理由（同 `ranking.ts` 的纪律）。
 */

/** 三路标识。与 `visual-eval.ts` 的报告列顺序一致。 */
export type VisualEvalPath = 'visual-only' | 'text-only' | 'hybrid'

/** 单路在全部样本上的判别性指标（与 `visual-eval.ts` 的 `pathStats` + 宏平均一致）。 */
export type VisualEvalPathMetrics = {
  /** 首选命中数：第 1 名的相关性等于样本内最高档的样本数。 */
  hits: number
  /** 出现排序倒置（不相关项压过相关项）的样本数，越少越好。 */
  inversions: number
  /** 宏平均 MRR。 */
  mrr: number
  /** 宏平均 NDCG@10。 */
  ndcgAt10: number
}

export type VisualEvalGateInput = {
  /** 参与评测的样本数。 */
  sampleCount: number
  paths: Record<VisualEvalPath, VisualEvalPathMetrics>
}

/** 一条不通过的门槛。`gate` 是给人看的短名，`detail` 带实测值与阈值。 */
export type VisualEvalViolation = {
  gate: string
  detail: string
}

/** 样本数下限：fixture 当前 21 条（12 条初版 + 9 条对抗性审查补齐）。 */
export const VISUAL_EVAL_MIN_SAMPLE_COUNT = 21

/** `hybrid` 的绝对下限。 */
export const VISUAL_EVAL_HYBRID_MIN_MRR = 0.95
export const VISUAL_EVAL_HYBRID_MIN_NDCG_AT_10 = 0.9
export const VISUAL_EVAL_HYBRID_MIN_HIT_RATE = 0.85
/** `hybrid` 允许出现排序倒置的样本数上限（实测 3）。 */
export const VISUAL_EVAL_HYBRID_MAX_INVERSIONS = 4

/** 相对优势的比较对象：两条单路基线。 */
const BASELINES: readonly Exclude<VisualEvalPath, 'hybrid'>[] = ['visual-only', 'text-only']

function fixed(value: number, digits = 3): string {
  return value.toFixed(digits)
}

/**
 * 评估门槛，返回**全部**违反项（不是遇到第一条就返回）。
 *
 * 一次给全的理由很实际：CI 失败时只看到一条，修完再跑又冒出下一条，会把一轮反馈拆成好几轮。
 */
export function evaluateVisualEvalGates(input: VisualEvalGateInput): VisualEvalViolation[] {
  const violations: VisualEvalViolation[] = []

  if (input.sampleCount < VISUAL_EVAL_MIN_SAMPLE_COUNT) {
    violations.push({
      gate: '样本数',
      detail: `样本数 ${input.sampleCount} < 下限 ${VISUAL_EVAL_MIN_SAMPLE_COUNT}（样本被删到不足以支撑结论）`,
    })
  }

  const hybrid = input.paths.hybrid
  if (hybrid === undefined) {
    violations.push({ gate: '路径缺失', detail: '缺少 hybrid 路的指标，无法判定' })
    return violations
  }

  if (hybrid.mrr < VISUAL_EVAL_HYBRID_MIN_MRR) {
    violations.push({
      gate: 'hybrid MRR 下限',
      detail: `hybrid MRR ${fixed(hybrid.mrr)} < ${fixed(VISUAL_EVAL_HYBRID_MIN_MRR)}`,
    })
  }
  if (hybrid.ndcgAt10 < VISUAL_EVAL_HYBRID_MIN_NDCG_AT_10) {
    violations.push({
      gate: 'hybrid NDCG@10 下限',
      detail: `hybrid NDCG@10 ${fixed(hybrid.ndcgAt10)} < ${fixed(VISUAL_EVAL_HYBRID_MIN_NDCG_AT_10)}`,
    })
  }

  const hitRate = input.sampleCount === 0 ? 0 : hybrid.hits / input.sampleCount
  if (hitRate < VISUAL_EVAL_HYBRID_MIN_HIT_RATE) {
    violations.push({
      gate: 'hybrid 首选命中率下限',
      detail: `hybrid 首选命中 ${hybrid.hits}/${input.sampleCount} = ${fixed(hitRate)} < ${fixed(VISUAL_EVAL_HYBRID_MIN_HIT_RATE)}`,
    })
  }
  if (hybrid.inversions > VISUAL_EVAL_HYBRID_MAX_INVERSIONS) {
    violations.push({
      gate: 'hybrid 排序倒置上限',
      detail: `hybrid 排序倒置 ${hybrid.inversions} > ${VISUAL_EVAL_HYBRID_MAX_INVERSIONS}`,
    })
  }

  // 相对优势：hybrid 必须在四个判别性指标上**严格优于**每一条单路。
  // 相等也算不通过——"三路同分"意味着这份 fixture 已经失去分辨力（见文件头注释）。
  for (const baseline of BASELINES) {
    const other = input.paths[baseline]
    if (other === undefined) {
      violations.push({ gate: '路径缺失', detail: `缺少 ${baseline} 路的指标，无法判定相对优势` })
      continue
    }
    if (!(hybrid.mrr > other.mrr)) {
      violations.push({
        gate: `hybrid > ${baseline} MRR`,
        detail: `hybrid ${fixed(hybrid.mrr)} 未严格优于 ${baseline} ${fixed(other.mrr)}`,
      })
    }
    if (!(hybrid.ndcgAt10 > other.ndcgAt10)) {
      violations.push({
        gate: `hybrid > ${baseline} NDCG@10`,
        detail: `hybrid ${fixed(hybrid.ndcgAt10)} 未严格优于 ${baseline} ${fixed(other.ndcgAt10)}`,
      })
    }
    if (!(hybrid.hits > other.hits)) {
      violations.push({
        gate: `hybrid > ${baseline} 首选命中`,
        detail: `hybrid ${hybrid.hits} 未严格多于 ${baseline} ${other.hits}`,
      })
    }
    if (!(hybrid.inversions < other.inversions)) {
      violations.push({
        gate: `hybrid < ${baseline} 排序倒置`,
        detail: `hybrid ${hybrid.inversions} 未严格少于 ${baseline} ${other.inversions}`,
      })
    }
  }

  return violations
}

/**
 * 门槛结果 → 进程退出码（`0` 通过 / `1` 不通过）。
 *
 * 为什么要单独抽成函数：这一行原本直接写成 `process.exitCode = 1` 躺在
 * `apps/api/scripts/visual-eval.ts` 的末尾，而那个脚本是**顶层执行**、没有可导入的入口，
 * 于是它**零单测覆盖**——把这一行删掉（或注释掉），`gates.test.ts` 照旧全绿，
 * 报告的每一个字符都不变，CI 却静默退回"评测腿永远绿"。这正是 #406 第 3 项要根除的失效模式。
 *
 * 抽成纯函数之后，"有违规 ⇒ 1 / 无违规 ⇒ 0"有了直接可断言的语义；
 * 脚本里那一行**接线本身**由 `gates.test.ts` 的源码守卫钉住（脚本没有可注入的入口，
 * 这是在不跑真实评测的前提下唯一能验证接线的方式，先例见 `apps/miniapp/tests/*-wiring.test.ts`）。
 */
export function gatesExitCode(violations: readonly VisualEvalViolation[]): 0 | 1 {
  return violations.length === 0 ? 0 : 1
}
