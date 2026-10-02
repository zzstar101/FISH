// ---------------------------------------------------------------------------
// #324 M9 离线评测腿：在人工标注样本上比较 visual-only / text-only / hybrid 三路的排序质量。
//
// ## 为什么分数是人工给的，而不是跑 provider 算出来的
//
// 与 #322 的 `apps/worker/scripts/rank-compare.ts` 完全同一取舍：**CI 不出网**。
// 本单的两路召回来自不同的上游（图片路要真实多模态 embedding，文本路要 OCR/VLM），
// 在本机跑一次真实上游既不可复现（模型与延迟都会变），又把「排序公式对不对」与
// 「模型语义好不好」混成一个分数。stub provider 更给不出可比较的尺度：它的图片向量是
// **字节哈希铺开**的，视觉上几乎相同的两张同款图在 stub 空间里彼此正交，拿它算
// Recall/NDCG 只会得到"随机数"级别的结论。
//
// 所以本脚本把每一路召回的相似度**当输入**（fixture 里人工给定），只评测 `ranking.ts`
// 的排序与度量这一层——唯一能用确定性样本钉死的部分。模型语义质量由 `visual:eval:db`
// 与 live 考核覆盖。
//
// 因此本脚本：**不连数据库、不出网、不需要任何环境变量**，只打印 Markdown 报告，
// **不设通过门槛**（只评估，不改生产行为，不因指标低而失败退出）。
//
// 运行：bun run visual:eval
//
// ## 三路的定义（注意缺失分项与 0 的区别）
//
// - `visual-only`：只给 `visualScore`，`textScore = null`、`categoryScore = null`。
//   `scoreVisualCandidate` 会把 null 分项**连同权重一起剔除**，于是这就是"图片相似度排序"。
// - `text-only`：只给 `textScore`。**不是**把 `visualScore` 置 null（它的类型不允许），
//   而是置 0——所以要读懂它的绝对分：它衡量"只看文本证据能把什么排上来"，
//   `visualScore = 0` 是所有候选取值相同的常量项，按权重均摊后不改变相对顺序。
// - `hybrid`：生产配置，`visualScore` + `textScore` + `categoryScore`（解析分类与候选分类
//   一致 = 1 / 不一致 = 0 / 没解析出分类 = null）。**门控与生产一致**：只有
//   `visualTextQueryOf(interpretation) !== null`（文本路真的会发起）时才把 `textScore`
//   计入，否则整项连同 0.2 的权重一起剔除——所以 `interpretation = null` 的样本上
//   hybrid 会**逐位退化成 visual-only**（见 `exact-parse-failed`）。
// ---------------------------------------------------------------------------

import { VISUAL_RANKING_WEIGHTS } from '@fish/contracts/visual/ranking'
import type {
  VisualEvalRelevance,
  VisualEvalSample,
} from '../src/modules/visual-search/eval/fixture'
import {
  REFERENCE_NOW,
  REQUIRED_SCENARIOS,
  VISUAL_EVAL_FIXTURE,
} from '../src/modules/visual-search/eval/fixture'
import {
  emptyResultRate,
  latencyPercentile,
  mrr,
  ndcgAtK,
  recallAtK,
  topKRelevanceRate,
} from '../src/modules/visual-search/eval/metrics'
import { visualTextQueryOf } from '../src/modules/visual-search/parse'
import {
  freshnessScore,
  popularityScore,
  scoreVisualCandidate,
} from '../src/modules/visual-search/ranking'

/** 三路的标识。数组顺序 = 报告里表格列的顺序。 */
const PATHS = ['visual-only', 'text-only', 'hybrid'] as const
type EvalPath = (typeof PATHS)[number]

/** 报告里 `Top-5 人工相关率` 用到的 K。 */
const TOP_K = 5

/** 固定时钟：fixture 的 `createdAt` 都相对它给出，保证 freshness 分项每次运行一致。 */
const NOW = REFERENCE_NOW

type RankedCandidate = {
  listingId: string
  title: string
  score: number
  /** 与生产同构的第二排序键（见 `rankSample`）。 */
  visualScore: number
  /** 人工相关性，报告里用来标 `2/1/0`。 */
  relevance: VisualEvalRelevance
}

/** hybrid 路的 `categoryScore`：解析出分类才参与（null 表示"这一路没有证据"）。 */
function categoryScoreOf(sample: VisualEvalSample, category: string): number | null {
  const interpretation = sample.query.interpretation
  if (!interpretation || interpretation.category === undefined) return null
  return interpretation.category === category ? 1 : 0
}

/**
 * 按某一路给一个样本排序。
 *
 * 排序键与生产的 `service.ts` 完全同构：**分数降序 → visualScore 降序 → id 升序**。
 * 前两级在 fixture 里几乎不会并列，第三级是为了让本脚本在并列时也**完全可复现**
 * （不依赖 `Array.prototype.sort` 的实现细节）。
 *
 * `hybrid` 的 `textScore` 口径与生产严格一致：只有 `visualTextQueryOf(interpretation)` 非 `null`
 * （即文本路**真的会发起**）时才取候选的 `textScore`；否则传 `null`，让 `scoreVisualCandidate`
 * 把它**连同 0.2 的权重一起剔除**。写成 `candidate.textScore ?? 0` 是错的——那会以 0.2 的权重
 * 给所有候选同时减去一个 0 分项：顺序不变，但"解析完全失败 ⇒ hybrid 退化成 visual-only"
 * 这个性质就再也测不出来了（`exact-parse-failed` 正是靠它把两者钉成逐位相等）。
 *
 * `text-only` 刻意**不做**这层门控：它是"只信文本路"的**反事实基准**，按定义就把
 * `visualScore` 置 0（见文件头），所有候选该项相同，均摊后不影响相对顺序。
 */
function rankSample(sample: VisualEvalSample, path: EvalPath): RankedCandidate[] {
  const hasTextQuery = visualTextQueryOf(sample.query.interpretation) !== null
  return sample.candidates
    .map((candidate) => {
      const freshness = freshnessScore(candidate.createdAt, NOW)
      const popularity = popularityScore(candidate.favoriteCount)
      const breakdown = scoreVisualCandidate({
        visualScore: path === 'text-only' ? 0 : candidate.visualScore,
        textScore: path === 'visual-only' || !hasTextQuery ? null : (candidate.textScore ?? 0),
        categoryScore: path === 'hybrid' ? categoryScoreOf(sample, candidate.category) : null,
        freshnessScore: freshness,
        popularityScore: popularity,
      })
      return {
        listingId: candidate.listingId,
        title: candidate.title,
        score: breakdown.score,
        visualScore: breakdown.visualScore,
        relevance: sample.relevance[candidate.listingId] ?? 0,
      }
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.visualScore - left.visualScore ||
        left.listingId.localeCompare(right.listingId),
    )
}

type SampleOutcome = {
  sample: VisualEvalSample
  ranked: Record<EvalPath, RankedCandidate[]>
}

/** 一次算完三路，后面所有表都从这份结果读，避免重复排序导致表间不自洽。 */
const OUTCOMES: SampleOutcome[] = VISUAL_EVAL_FIXTURE.map((sample) => ({
  sample,
  ranked: {
    'visual-only': rankSample(sample, 'visual-only'),
    'text-only': rankSample(sample, 'text-only'),
    hybrid: rankSample(sample, 'hybrid'),
  },
}))

function fixed(value: number, digits = 3): string {
  return value.toFixed(digits)
}

function percent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`
}

/** 对全部样本取某个单查询指标的**宏平均**（每个样本等权，与候选池大小无关）。 */
function meanOf(compute: (outcome: SampleOutcome) => number): number {
  if (OUTCOMES.length === 0) return 0
  const total = OUTCOMES.reduce((sum, outcome) => sum + compute(outcome), 0)
  return total / OUTCOMES.length
}

/** 主指标表：行 = 指标，列 = 三路。 */
function metricsTable(): string[][] {
  const rows: string[][] = []
  rows.push([
    'Recall@5（≥1 相关）',
    ...PATHS.map((path) => fixed(meanOf((o) => recallAtK(ids(o, path), o.sample.relevance, 5)))),
  ])
  rows.push([
    'Recall@10（≥1 相关）',
    ...PATHS.map((path) => fixed(meanOf((o) => recallAtK(ids(o, path), o.sample.relevance, 10)))),
  ])
  rows.push([
    'MRR',
    ...PATHS.map((path) => fixed(meanOf((o) => mrr(ids(o, path), o.sample.relevance)))),
  ])
  rows.push([
    'NDCG@10',
    ...PATHS.map((path) => fixed(meanOf((o) => ndcgAtK(ids(o, path), o.sample.relevance, 10)))),
  ])
  rows.push([
    'Top-5 人工相关率（≥1）',
    ...PATHS.map((path) =>
      fixed(meanOf((o) => topKRelevanceRate(ids(o, path), o.sample.relevance, TOP_K))),
    ),
  ])
  return rows
}

function ids(outcome: SampleOutcome, path: EvalPath): string[] {
  return outcome.ranked[path].map((entry) => entry.listingId)
}

function renderMetricsTable(): string {
  const rows = metricsTable()
  const lines = [
    `| 指标 | ${PATHS.join(' | ')} |`,
    `| --- | ${PATHS.map(() => '---').join(' | ')} |`,
  ]
  for (const row of rows) lines.push(`| ${row.join(' | ')} |`)
  return lines.join('\n')
}

/**
 * 人工判断里"最该排第一"的**相关性档位**（样本内的最高相关性）。
 *
 * 注意这里刻意返回**档位**而不是某个 `listingId`：候选池里经常有两三条同为
 * `relevance = 2` 的同款（正样本本来就是这个样子），此时"第 1 名必须等于某一条特定 id"
 * 是个假要求——按 id 字典序挑一条当标准答案，会把"排到了另一条真同款前面"误判成失败。
 * 判据统一为：**第 1 名的相关性 = 样本内最高相关性**。
 */
function humanTopRelevance(sample: VisualEvalSample): VisualEvalRelevance {
  let best: VisualEvalRelevance = 0
  for (const value of Object.values(sample.relevance)) {
    if (value > best) best = value
  }
  return best
}

/** 某一路在全部样本上的两个判别性统计：首选命中 / 出现排序倒置的样本数。 */
function pathStats(path: EvalPath): { hits: number; inversions: number } {
  let hits = 0
  let inversions = 0
  for (const outcome of OUTCOMES) {
    const ranked = outcome.ranked[path]
    const best = humanTopRelevance(outcome.sample)
    if (best >= 1 && (ranked[0]?.relevance ?? 0) === best) hits += 1

    // 倒置：存在一条不相关项（rel=0）排在至少一条相关项（rel≥1）之前。
    // Recall 看不见这种退化（相关项仍在前 K 里），NDCG 也只是扣一点分——所以单独计数。
    const firstIrrelevant = ranked.findIndex((entry) => entry.relevance === 0)
    if (firstIrrelevant === -1) continue
    const hasRelevantAfter = ranked.slice(firstIrrelevant + 1).some((entry) => entry.relevance >= 1)
    if (hasRelevantAfter) inversions += 1
  }
  return { hits, inversions }
}

/**
 * 逐样本排序结果：每行一个样本，三路各给出**前 3 名**，并标出人工相关性。
 *
 * 形态照 `rank-compare.ts` 的"召回顺序"表：`\`id\`(rel)` 顿号连接，超出前 3 名的省略号收尾。
 */
function renderPerSample(): string {
  const lines: string[] = []
  for (const outcome of OUTCOMES) {
    const best = humanTopRelevance(outcome.sample)
    lines.push(`### \`${outcome.sample.id}\`（${outcome.sample.sampleClass}）`)
    lines.push('')
    // 标注理由（为什么这些分数、为什么这样分级）写在 fixture 的 rationale 里，
    // 报告只回放排序结果，避免把同一段长文打印两遍。
    lines.push(`| 路 | Top-3（括号内为人工相关性） | 第 1 名是最高相关档（rel=${best}） |`)
    lines.push('| --- | --- | --- |')
    for (const path of PATHS) {
      const head = outcome.ranked[path].slice(0, 3)
      const detail =
        head.map((entry) => `\`${entry.listingId}\`(${entry.relevance})`).join('、') +
        (outcome.ranked[path].length > 3 ? ' …' : '')
      const hit = (outcome.ranked[path][0]?.relevance ?? 0) === best
      lines.push(`| ${path} | ${detail} | ${hit ? '✅' : '❌'} |`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * 人工判断不一致清单（照 `rank-compare.ts` 的「误判清单」风格）。
 *
 * 三类偏差分别列出，因为它们的修法不同：
 * - **首选错位**：第 1 名的相关性低于样本内最高档（把难样本或负样本顶到了第一）。
 * - **相关项被不相关项压住**：存在 `relevance = 0` 的项排在 `relevance ≥ 1` 的项之前——
 *   这是本 Issue 最关心的退化，图片路最容易犯，而 Recall 完全看不见它。
 * - **负样本混入 Top-5**：`relevance = 0` 的项出现在 Top-5 里。
 */
function disagreementLines(path: EvalPath): string[] {
  const lines: string[] = []
  for (const outcome of OUTCOMES) {
    const { sample } = outcome
    const ranked = outcome.ranked[path]
    const head = ranked[0]
    const best = humanTopRelevance(sample)
    const details: string[] = []

    if (best >= 1 && (head?.relevance ?? 0) !== best) {
      details.push(
        `首选错位（第 1 名 \`${head?.listingId}\`(rel=${head?.relevance ?? 0}) 低于最高档 rel=${best}）`,
      )
    }
    const firstIrrelevant = ranked.findIndex((entry) => entry.relevance === 0)
    if (firstIrrelevant !== -1) {
      const overtaken = ranked
        .slice(firstIrrelevant + 1)
        .filter((entry) => entry.relevance >= 1)
        .map((entry) => `\`${entry.listingId}\`(rel=${entry.relevance})`)
      if (overtaken.length > 0) {
        details.push(
          `相关项被不相关项压住：\`${ranked[firstIrrelevant]?.listingId}\`(rel=0) 排在 ${overtaken.join('、')} 之前`,
        )
      }
    }
    const intruders = ranked
      .slice(0, TOP_K)
      .filter((entry) => entry.relevance === 0)
      .map((entry) => `\`${entry.listingId}\``)
    if (intruders.length > 0) {
      details.push(`Top-5 混入不相关：${intruders.join('、')}`)
    }

    lines.push(
      `- \`${sample.id}\`（${sample.sampleClass}）：${details.length > 0 ? details.join('；') : '无'}`,
    )
  }
  return lines
}

/**
 * 一致性总览。两个指标并排，因为它们捕捉的是不同的退化：
 * - **首选命中**：第 1 名的相关性 = 样本内最高档（并列多条同款时任一都算对）。
 * - **排序倒置**：存在不相关项压过相关项——Recall 对此完全免疫，必须单独计数。
 */
function agreementTable(): string[] {
  const lines = ['| 路 | 首选命中 | 命中率 | 出现排序倒置的样本数 |', '| --- | --- | --- | --- |']
  for (const path of PATHS) {
    const { hits, inversions } = pathStats(path)
    lines.push(
      `| ${path} | ${hits}/${OUTCOMES.length} | ${percent(hits / OUTCOMES.length)} | ${inversions} |`,
    )
  }
  return lines
}

/** 按样本类别拆开的首选命中率：能看出"hybrid 的提升主要发生在哪一类样本上"。 */
function agreementByClassTable(): string[] {
  const classes = [...new Set(OUTCOMES.map((outcome) => outcome.sample.sampleClass))]
  const lines = [
    `| 样本类别（条数） | ${PATHS.join(' | ')} |`,
    `| --- | ${PATHS.map(() => '---').join(' | ')} |`,
  ]
  for (const sampleClass of classes) {
    const group = OUTCOMES.filter((outcome) => outcome.sample.sampleClass === sampleClass)
    const cells = PATHS.map((path) => {
      let hit = 0
      for (const outcome of group) {
        const best = humanTopRelevance(outcome.sample)
        if ((outcome.ranked[path][0]?.relevance ?? 0) === best) hit += 1
      }
      return `${hit}/${group.length}`
    })
    lines.push(`| ${sampleClass}（${group.length}） | ${cells.join(' | ')} |`)
  }
  return lines
}

/**
 * 场景覆盖表（#324 M9 对抗性审查 B1 的**可核查回执**）。
 *
 * `sampleClass` 只有四类，看不出"Issue 点名的那些维度到底有没有样本"：背景复杂 / 多物体 /
 * 模糊低光 / 截图而非实拍 / 同品牌不同品类，以及此前只有名义覆盖的同款不同角度 /
 * 同型号不同背景 / 同色不同物体，还有解析完全失败（`interpretation = null`）。
 * 这张表按 `scenario` 聚合，并列出每一路上"首选命中 / 该类样本数"。
 *
 * 覆盖本身由 `fixture.ts` 加载期的 `REQUIRED_SCENARIOS` 断言保证；这里只是把保证打印出来。
 */
function scenarioCoverageTable(): string[] {
  const scenarios = [...new Set(OUTCOMES.map((outcome) => outcome.sample.scenario))]
  const lines = [
    `| 场景 | Issue 点名 | 样本数 | ${PATHS.join(' | ')} |`,
    `| --- | --- | --- | ${PATHS.map(() => '---').join(' | ')} |`,
  ]
  for (const scenario of scenarios) {
    const group = OUTCOMES.filter((outcome) => outcome.sample.scenario === scenario)
    const cells = PATHS.map((path) => {
      let hit = 0
      for (const outcome of group) {
        const best = humanTopRelevance(outcome.sample)
        if ((outcome.ranked[path][0]?.relevance ?? 0) === best) hit += 1
      }
      return `${hit}/${group.length}`
    })
    const required = REQUIRED_SCENARIOS.includes(scenario) ? '★' : ''
    lines.push(`| \`${scenario}\` | ${required} | ${group.length} | ${cells.join(' | ')} |`)
  }
  return lines
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

console.log('# #324 M9 拍照识图搜索离线评测（人工标注 fixture）')
console.log('')
console.log(
  `- 样本数：${VISUAL_EVAL_FIXTURE.length}（人工相关性分级：2 = 同款，1 = 部分相关，0 = 不相关）`,
)
console.log(`- 固定时钟（freshness 分项基准）：${NOW.toISOString()}`)
console.log(
  `- 排序权重（生产配置）：${Object.entries(VISUAL_RANKING_WEIGHTS)
    .map(([name, weight]) => `${name}=${weight}`)
    .join('、')}`,
)
console.log(
  '- 相似度来源：**人工给定**（见 fixture 头注释）。本脚本不出网、不连数据库、不设通过门槛。',
)
console.log('')

console.log('## 一、三路主指标')
console.log('')
console.log(renderMetricsTable())
console.log('')
console.log(
  `- 说明：` +
    `Recall@K 的分母是**标注出的相关项总数**（fixture 的候选池是采样过的），衡量"把已知相关项捞进 Top-K"的能力；` +
    `Top-5 人工相关率的分母是**实际返回的位置数**（候选池不足 ${TOP_K} 条时分母取真实条数）。`,
)
console.log(
  '- ⚠️ 这个 fixture 上 **Recall@5 / Recall@10 / Top-5 人工相关率三路完全相同**：' +
    '每条样本只有 4–5 个候选，Top-5 覆盖全池；而 Recall 只要不漏就都是 1.000。' +
    '这不是脚本的缺陷，是候选池分辨率的真实上限——**不要用这三行去论证三路有差别**，' +
    '看下面的首选命中率与排序倒置数。想知道线上召回率与空结果率，必须跑 `visual:eval:db`。',
)
console.log(
  '- `text-only` 的绝对分偏低是定义使然：它把 `visualScore` 置 0（类型不允许 null），' +
    '所有候选的该项取值相同，均摊后不影响相对顺序。',
)
console.log('')

console.log('## 二、与人工判断的一致性')
console.log('')
console.log(agreementTable().join('\n'))
console.log('')
console.log(
  '- 「首选命中」= 第 1 名的相关性等于样本内最高档。候选池里常有 2–3 条同为 `relevance = 2` 的同款，' +
    '此时任一排在首位都算命中——按 id 指定唯一"标准答案"会把"排到了另一条真同款前面"误判为失败。',
)
console.log(
  '- 「排序倒置」= 至少一条 `relevance = 0` 的项排在 `relevance ≥ 1` 的项之前。' +
    '这类退化 Recall 完全看不见（相关项仍在前 K 内），NDCG 也只扣一点分，所以单独计数。',
)
console.log('')
console.log('### 按样本类别拆开（首选命中数 / 该类样本数）')
console.log('')
console.log(agreementByClassTable().join('\n'))
console.log('')
console.log('### 按场景拆开（★ = Issue #324 M9 点名维度，缺一条 fixture 会加载即抛）')
console.log('')
console.log(scenarioCoverageTable().join('\n'))
console.log('')
{
  const missing = REQUIRED_SCENARIOS.filter(
    (scenario) => !OUTCOMES.some((outcome) => outcome.sample.scenario === scenario),
  )
  console.log(
    missing.length === 0
      ? `- ✅ ${REQUIRED_SCENARIOS.length} 个 Issue 点名场景全部有样本承载（断言见 \`assertFixtureIntegrity\`）。`
      : `- ❌ 缺少必需场景：${missing.join('、')}`,
  )
}
console.log('')

console.log('## 三、逐样本排序结果')
console.log('')
console.log(renderPerSample())

console.log('## 四、与人工判断不一致清单')
console.log('')
for (const path of PATHS) {
  console.log(`### ${path}`)
  console.log('')
  console.log(disagreementLines(path).join('\n'))
  console.log('')
}

// ---------------------------------------------------------------------------
// 附：empty-result rate 与 latency 为什么不在这一腿
//
// 二者都必须**真跑**才有意义（空结果取决于库里到底有没有可召回的向量，延迟取决于
// Postgres + provider），人工 fixture 给不出任何一个。它们由同 Issue 的 DB 端到端腿
// `bun run visual:eval:db` 度量。这里只把两个函数"接上"证明它们在纯函数层可用
// （避免"写了却没人用"的死代码），不打印任何结论。
// ---------------------------------------------------------------------------

const offlineResults = OUTCOMES.map((outcome) => ({
  itemCount: outcome.ranked.hybrid.length,
}))
const selfCheck = {
  // 离线样本的候选池非空，所以空结果率恒为 0；这里驱动函数是为了让它进入调用图。
  emptyResultRate: emptyResultRate(offlineResults),
  // 离线腿没有网络往返，延迟样本为空 → 分位函数返回 0（边界已定义）。
  p95Latency: latencyPercentile([], 0.95),
}
if (selfCheck.emptyResultRate !== 0 || selfCheck.p95Latency !== 0) {
  console.log(`> 内部自检异常：${JSON.stringify(selfCheck)}`)
}
