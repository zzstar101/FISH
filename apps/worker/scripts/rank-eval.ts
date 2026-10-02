// ---------------------------------------------------------------------------
// #323 R6 离线评估 CLI：回放已落库的请求 / 快照 / 事件，打印排序质量、覆盖与曝光分布、
// 特征分布、商品侧生命周期（Issue 的 M8 验收项）。
//
// 运行（仓库根目录，Bun 自动读根 `.env`）：
//   bun run rank:eval -- --window=7d [--since=ISO] [--until=ISO] [--k=5,10,20] [--json] [--limit-requests=N]
//   bun run rank:eval -- --fixture        # 不连库、不出网，确定性样本，CI 用
//
// 两种模式共用 `apps/worker/src/jobs/recommendation/eval.ts` 的纯函数：
// 指标口径只有一份，脚本只负责取数（`store.ts`）与打印。
//
// 注意：这里的数字**只用于离线调查**，不进任何线上端点（N5）。窗口末端若早于「现在」，
// 后续正向事件还没有产生，指标会偏低——所以输出里必须带分母与实际回放区间。
// ---------------------------------------------------------------------------

import {
  RANK_EVAL_ATTRIBUTION_WINDOW_MS,
  RANK_EVAL_DEFAULT_WINDOW_DAYS,
  RANK_EVAL_K_VALUES,
} from '@fish/contracts/recommendation/eval'
import { RECOMMENDATION_CONTEXT_RETENTION_DAYS } from '@fish/contracts/recommendation/observability'
import { createDb } from '@fish/db/client'
import { loadServerEnv } from '@fish/shared/env'
import { computeRankEvalMetrics, type RankEvalMetrics } from '../src/jobs/recommendation/eval'
import { RANK_EVAL_FIXTURE } from '../src/jobs/recommendation/eval-fixture'
import { createRankEvalStore } from '../src/jobs/recommendation/store'

const DAY_MS = 86_400_000

const USAGE = `用法：
  bun run rank:eval -- [--window=24h|7d|30d|Nd|Nh] [--since=ISO] [--until=ISO]
                       [--k=5,10,20] [--json] [--limit-requests=N]
  bun run rank:eval -- --fixture
`

type CliOptions = {
  fixture: boolean
  json: boolean
  windowMs: number
  since: Date | null
  until: Date | null
  kValues: readonly number[]
  limitRequests: number | null
}

function parseDuration(text: string): number {
  const matched = /^(\d+)([hd])$/.exec(text)
  if (matched === null) throw new Error(`窗口格式应为 24h / 7d / 30d，实得 ${text}`)
  const amount = Number(matched[1])
  if (amount <= 0) throw new Error(`窗口必须是正数，实得 ${text}`)
  return amount * (matched[2] === 'd' ? DAY_MS : 3_600_000)
}

function parseIso(text: string, flag: string): Date {
  const parsed = new Date(text)
  if (Number.isNaN(parsed.getTime())) throw new Error(`${flag} 不是合法 ISO 时间：${text}`)
  return parsed
}

function parseKValues(text: string): number[] {
  const values = text.split(',').map((part) => Number(part.trim()))
  if (values.length === 0 || values.some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new Error(`--k 应为正整数列表，如 --k=5,10,20，实得 ${text}`)
  }
  return [...new Set(values)].sort((a, b) => a - b)
}

export function parseArgs(argv: readonly string[]): CliOptions {
  let fixture = false
  let json = false
  let windowMs = RANK_EVAL_DEFAULT_WINDOW_DAYS * DAY_MS
  let since: Date | null = null
  let until: Date | null = null
  let kValues: readonly number[] = RANK_EVAL_K_VALUES
  let limitRequests: number | null = null

  for (const arg of argv) {
    if (arg === '--fixture') {
      fixture = true
    } else if (arg === '--json') {
      json = true
    } else if (arg === '--help' || arg === '-h') {
      console.log(USAGE)
      process.exit(0)
    } else if (arg.startsWith('--window=')) {
      windowMs = parseDuration(arg.slice('--window='.length))
    } else if (arg.startsWith('--since=')) {
      since = parseIso(arg.slice('--since='.length), '--since')
    } else if (arg.startsWith('--until=')) {
      until = parseIso(arg.slice('--until='.length), '--until')
    } else if (arg.startsWith('--k=')) {
      kValues = parseKValues(arg.slice('--k='.length))
    } else if (arg.startsWith('--limit-requests=')) {
      const value = Number(arg.slice('--limit-requests='.length))
      if (!Number.isInteger(value) || value <= 0)
        throw new Error(`--limit-requests 应为正整数，实得 ${arg}`)
      limitRequests = value
    } else {
      throw new Error(`未知参数：${arg}\n${USAGE}`)
    }
  }

  return { fixture, json, windowMs, since, until, kValues, limitRequests }
}

/** 时间窗：显式给的一端优先，另一端按窗口推。 */
function resolveWindow(options: CliOptions, now: Date): { since: Date; until: Date } {
  const until = options.until ?? now
  const since = options.since ?? new Date(until.getTime() - options.windowMs)
  if (!(since < until))
    throw new Error(`回放区间为空：since=${since.toISOString()} until=${until.toISOString()}`)
  return { since, until }
}

function number(value: number, digits = 4): string {
  return value.toFixed(digits)
}

/** 分母为 0 的比率/分位是 `null`（"无法判定"），与"真的是 0"必须能区分，所以打印成 `—`。 */
function maybe(value: number | null, digits = 4): string {
  return value === null ? '—' : number(value, digits)
}

function percent(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(2)}%`
}

function hours(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(2)}h`
}

/** 手写表格行（避免为了打印引一个 markdown 库）。 */
function tableRow(cells: readonly (string | number)[]): string {
  return `| ${cells.join(' | ')} |`
}

function renderMarkdown(metrics: RankEvalMetrics, source: string): string {
  const lines: string[] = []
  const sample = metrics.sample

  lines.push(`## 推荐离线评估（${source}）`)
  lines.push('')
  lines.push(
    `- 回放区间：\`${metrics.since.toISOString()}\` → \`${metrics.until.toISOString()}\`（左闭右开）`,
  )
  lines.push(
    `- K：${metrics.kValues.join(' / ')}；归因窗 W：${RANK_EVAL_ATTRIBUTION_WINDOW_MS / 60_000} 分钟`,
  )
  lines.push(
    `- 样本量：请求 ${sample.requests}（评估 ${sample.evaluatedRequests}、降级 ${sample.degradedRequests}、` +
      `无快照 ${sample.requestsWithoutSnapshot}、无正向信号 ${sample.requestsWithoutPositiveSignal}）、` +
      `快照行 ${sample.snapshotItems}、归因事件 ${sample.attributedEvents}`,
  )
  if (metrics.skippedBreakdownRows > 0 || metrics.missingListingRefs > 0) {
    lines.push(
      `- 数据质量：\`rank_breakdown\` 形状不符 ${metrics.skippedBreakdownRows} 行、` +
        `缺失商品元数据 ${metrics.missingListingRefs} 处（相关指标按"无法判定"跳过）`,
    )
  }
  if (metrics.kValues.length > 0 && metrics.quality[0]?.requests === 0) {
    lines.push('- ⚠ 质量指标的分母为 0：这批数据里没有任何请求带正向信号，Recall/MRR/NDCG 无意义。')
  }
  lines.push('')

  lines.push('### 排序质量（请求级，分母 = 有正向信号的请求数）')
  lines.push('')
  lines.push(tableRow(['K', '请求数', 'Σ|R(r)|', 'Recall@K', 'MRR@K', 'NDCG@K']))
  lines.push(tableRow(['---', '---', '---', '---', '---', '---']))
  for (const row of metrics.quality) {
    lines.push(
      tableRow([
        row.k,
        row.requests,
        row.relevantListings,
        row.recall === null ? '—' : number(row.recall),
        row.mrr === null ? '—' : number(row.mrr),
        row.ndcg === null ? '—' : number(row.ndcg),
      ]),
    )
  }
  lines.push('')
  lines.push(
    '> `Σ|R(r)|` 是这些请求的相关集总规模：`Recall@K = 1.0` 在 1 个请求和 50 个请求上不是一回事。',
  )
  lines.push('')

  const coverage = metrics.coverage
  const detail = metrics.coverageDetail
  lines.push('### 覆盖与曝光分布')
  lines.push('')
  lines.push(tableRow(['指标', '值', '分子 / Σ', '分母 / 样本数']))
  lines.push(tableRow(['---', '---', '---', '---']))
  lines.push(
    tableRow([
      '商品覆盖率',
      percent(coverage.coverage),
      coverage.recommendedListings,
      coverage.visibleListings,
    ]),
  )
  lines.push(
    tableRow([
      '卖家覆盖率',
      percent(coverage.sellerCoverage),
      coverage.recommendedSellers,
      coverage.visibleSellers,
    ]),
  )
  lines.push(
    tableRow([
      '类目多样性（Gini–Simpson 均值）',
      maybe(coverage.categoryDiversity),
      maybe(detail.categoryDiversity.sum),
      detail.categoryDiversity.samples,
    ]),
  )
  lines.push(
    tableRow([
      '每请求去重类目数（均值）',
      maybe(coverage.categoriesPerRequest),
      maybe(detail.categoriesPerRequest.sum),
      detail.categoriesPerRequest.samples,
    ]),
  )
  lines.push(
    tableRow([
      '新鲜商品曝光率',
      percent(coverage.freshItemExposureRate),
      detail.freshItemExposure.fresh,
      detail.freshItemExposure.samples,
    ]),
  )
  lines.push(
    tableRow([
      '重复曝光率',
      percent(coverage.repeatedExposureRate),
      detail.repeatedExposure.extras,
      detail.repeatedExposure.samples,
    ]),
  )
  lines.push('')
  lines.push(
    '> 均值行（类目多样性 / 每请求类目数）的「分子」是 Σ、「分母」是样本数，比值即「值」。',
  )
  lines.push('')

  lines.push('### 特征分布（来自快照 `rank_breakdown.normalized`）')
  lines.push('')
  lines.push(tableRow(['特征', '样本数', '均值', 'p50', 'p95', 'missing 次数']))
  lines.push(tableRow(['---', '---', '---', '---', '---', '---']))
  for (const row of metrics.features) {
    lines.push(
      tableRow([
        row.key,
        row.samples,
        maybe(row.mean),
        maybe(row.p50),
        maybe(row.p95),
        row.missingCount,
      ]),
    )
  }
  lines.push('')

  lines.push('### 通道分账（按快照 `primary_source`，只统计可归因位次）')
  lines.push('')
  lines.push(tableRow(['primary_source', '位次数', '带来正向信号的商品数']))
  lines.push(tableRow(['---', '---', '---']))
  for (const row of metrics.channelAccounting) {
    lines.push(tableRow([row.primarySource ?? '(空)', row.positions, row.relevantListings]))
  }
  lines.push('')

  const lifecycle = metrics.lifecycle
  lines.push('### 商品侧生命周期')
  lines.push('')
  lines.push(tableRow(['指标', '样本数', '中位数', 'p90']))
  lines.push(tableRow(['---', '---', '---', '---']))
  lines.push(
    tableRow([
      '新建 → 首次归因曝光',
      lifecycle.newListingTimeToFirstExposureHours.count,
      hours(lifecycle.newListingTimeToFirstExposureHours.median),
      hours(lifecycle.newListingTimeToFirstExposureHours.p90),
    ]),
  )
  lines.push(
    tableRow([
      '发布 → 首次有效意向（grade ≥ 2）',
      lifecycle.firstPublishToFirstIntentHours.count,
      hours(lifecycle.firstPublishToFirstIntentHours.median),
      hours(lifecycle.firstPublishToFirstIntentHours.p90),
    ]),
  )
  lines.push(
    tableRow([
      '成交前归因曝光次数',
      lifecycle.exposuresBeforeSale.count,
      maybe(lifecycle.exposuresBeforeSale.median, 2),
      maybe(lifecycle.exposuresBeforeSale.p90, 2),
    ]),
  )
  lines.push('')
  return lines.join('\n')
}

function renderRetentionNote(since: Date, until: Date, now: Date): string {
  const horizon = new Date(now.getTime() - RECOMMENDATION_CONTEXT_RETENTION_DAYS * DAY_MS)
  const notes: string[] = []
  if (since < horizon) {
    notes.push(
      `⚠ 回放起点早于请求上下文保留期（${RECOMMENDATION_CONTEXT_RETENTION_DAYS} 天）：请求/快照侧可能已被清理，` +
        '相关事件会因归因缺失而静默丢失（§4.4），本次指标偏低。',
    )
  }
  if (until > now) {
    notes.push('⚠ 回放终点晚于当前时间：该区间的事件尚未全部产生。')
  }
  if (notes.length === 0) notes.push('回放区间完全落在保留期内，未发生截断。')
  return notes.join('\n')
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const now = new Date()

  if (options.fixture) {
    const metrics = computeRankEvalMetrics(RANK_EVAL_FIXTURE, { kValues: options.kValues })
    if (options.json) {
      console.log(JSON.stringify({ mode: 'fixture', metrics }, null, 2))
      return
    }
    console.log(renderMarkdown(metrics, 'fixture 确定性样本'))
    return
  }

  const { since, until } = resolveWindow(options, now)
  const env = loadServerEnv()
  const db = createDb(env.DATABASE_URL)
  try {
    const store = createRankEvalStore(db)
    const dataset = await store.loadDataset({
      since,
      until,
      attributionWindowMs: RANK_EVAL_ATTRIBUTION_WINDOW_MS,
      ...(options.limitRequests === null ? {} : { limitRequests: options.limitRequests }),
    })
    const metrics = computeRankEvalMetrics(dataset, { kValues: options.kValues })
    const note = renderRetentionNote(since, until, now)

    if (options.json) {
      console.log(JSON.stringify({ mode: 'database', retention: note, metrics }, null, 2))
      return
    }
    console.log(renderMarkdown(metrics, '数据库回放'))
    console.log(note)
  } finally {
    await db.$client.close()
  }
}

// `import.meta.main` 守卫是必须的：`rank-eval.test.ts` 要 import `parseArgs` 做进程内单测，
// 没有守卫时 import 本身就会跑一遍 CLI（默认数据库模式，连不上库就直接炸）。
if (import.meta.main) {
  await main()
}
