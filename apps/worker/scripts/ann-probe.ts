// ---------------------------------------------------------------------------
// #322 M4 ANN 决策复测脚本：exact cosine scan 的延迟随行数怎么走，以及 HNSW 值不值。
//
// 触发条件（M2 记录 / Issue）：p95 > 50ms 或"带向量实体 > ~10 万行"才考虑 HNSW。
// M2 已测过真实路径：5000 行 / 1536 维 exact scan 的 `explain (analyze)` 是
// `Limit → Sort (top-N heapsort) → Nested Loop → Seq Scan`，Execution Time 40.9ms，暂不建索引。
// 本脚本把行数推到 1 万 / 5 万 / 10 万，看这条曲线是不是还在触发线以下。
//
// 运行（仓库根目录）：bun run ann:probe
//       bun run apps/worker/scripts/ann-probe.ts -- --sizes=10000,50000 --no-index
//
// 语料来源（`--source`，#322 M4 复审修复：范围外发现 #3）：
//   * `auto`（默认）：库里有足够多**真实**向量（`embeddings` 中 `dimensions` 匹配、条数 ≥ 最大
//     `--sizes`）就用真实的，否则退回合成随机向量——返回里带 `source`，永远不用猜这批数字是哪来的；
//   * `real`：只用真实向量，条数不够直接 exit 2（提示 `bun run embed:backfill` / 减少 `--sizes`）；
//     真实向量**不重复使用**（重复行会让 HNSW 的 recall 虚高）；
//   * `synthetic`：合成随机向量（`random()`），复现 §5 那批"代码验证"数字时用它。
//   为什么要有 real：随机向量的 HNSW 邻域结构与真实 embedding 分布不同，recall 损失只能在真实分布上量。
//
// 口径与局限（写进 M4 设计文档时必须一起写）：
//   * 向量灌在**临时表** `ann_probe`（同 `vector(1536)` 列类型、同 `<=>` 距离算子、同 `LIMIT k`
//     形态），因此数字是**真实路径的下界**——生产查询还要 join `listings` / `wishes` 并套
//     新鲜度与收窄谓词，只会更慢；脚本另附当前真实表的行数与真实查询的 `explain (analyze)` 作锚点。
//   * 临时表随会话销毁，**不碰任何业务表**，也不需要迁移 —— M4 的"零迁移"承诺成立。
//   * HNSW 那半段（`--with-index`，默认开）在同一张临时表上建索引再测一次，量的是"有索引"的
//     对照；索引建完不落盘（不是生产变更）。
// ---------------------------------------------------------------------------

import { MATCH_SEMANTIC_TOP_K } from '@fish/contracts/matching/schema'
import type { Db } from '@fish/db/client'
import { createDb } from '@fish/db/client'
import { EMBEDDING_DIMENSIONS } from '@fish/db/schema/embeddings'
import { loadServerEnv } from '@fish/shared/env'
import { sql } from 'drizzle-orm'
import { logEvent } from '../src/log'

const DEFAULT_SIZES = [10_000, 50_000, 100_000]
const DEFAULT_QUERIES = 5

type Options = {
  sizes: number[]
  queries: number
  k: number
  withIndex: boolean
  /** `auto`：库里够就用真实向量；`real`：不够就报错；`synthetic`：始终用随机向量。 */
  source: 'auto' | 'real' | 'synthetic'
}

class UsageError extends Error {}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    sizes: DEFAULT_SIZES,
    queries: DEFAULT_QUERIES,
    k: MATCH_SEMANTIC_TOP_K,
    withIndex: true,
    source: 'auto',
  }

  for (const arg of argv) {
    if (arg === '--no-index') {
      options.withIndex = false
    } else if (arg.startsWith('--source=')) {
      const value = arg.slice('--source='.length)
      if (value !== 'auto' && value !== 'real' && value !== 'synthetic') {
        throw new UsageError(`--source 需要 auto | real | synthetic，收到 ${JSON.stringify(arg)}`)
      }
      options.source = value
    } else if (arg.startsWith('--sizes=')) {
      const sizes = arg
        .slice('--sizes='.length)
        .split(',')
        .map((raw) => Number(raw))
      if (sizes.length === 0 || sizes.some((size) => !Number.isInteger(size) || size <= 0)) {
        throw new UsageError(`--sizes 需要正整数列表，收到 ${JSON.stringify(arg)}`)
      }
      options.sizes = [...new Set(sizes)].sort((a, b) => a - b)
    } else if (arg.startsWith('--queries=')) {
      const value = Number(arg.slice('--queries='.length))
      if (!Number.isInteger(value) || value < 1 || value > 50) {
        throw new UsageError('--queries 需要 1..50 之间的整数')
      }
      options.queries = value
    } else if (arg.startsWith('--k=')) {
      const value = Number(arg.slice('--k='.length))
      if (!Number.isInteger(value) || value < 1 || value > 1000) {
        throw new UsageError('--k 需要 1..1000 之间的整数')
      }
      options.k = value
    } else {
      throw new UsageError(`未知参数 ${JSON.stringify(arg)}`)
    }
  }

  return options
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  const rows = (result as { rows?: unknown }).rows
  return Array.isArray(rows) ? (rows as T[]) : []
}

type PlanNode = {
  'Node Type'?: string
  'Actual Total Time'?: number
  'Actual Rows'?: number
  Plans?: PlanNode[]
}

type ExplainJson = { Plan: PlanNode; 'Planning Time'?: number; 'Execution Time'?: number }

/** 把 `explain (format json)` 的计划树摊成几行文本（证据写进 M4 文档时直接可用）。 */
function renderPlan(node: PlanNode, depth = 0): string[] {
  const indent = '  '.repeat(depth)
  const actual =
    node['Actual Total Time'] === undefined
      ? ''
      : ` (actual time=${node['Actual Total Time'].toFixed(2)}ms rows=${node['Actual Rows']})`
  return [
    `${indent}${node['Node Type']}${actual}`,
    ...(node.Plans ?? []).flatMap((child) => renderPlan(child, depth + 1)),
  ]
}

/** 跑一次 `explain (analyze, buffers, format json)` 并取真实执行耗时与计划树。 */
async function explainAnalyze(
  db: Db,
  query: ReturnType<typeof sql>,
): Promise<{ executionMs: number; planLines: string[]; planningMs: number | null }> {
  const rows = rowsOf<Record<string, ExplainJson[]>>(
    await db.execute(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`),
  )
  const payload = rows[0]?.['QUERY PLAN']?.[0]
  if (payload === undefined) throw new Error('explain 没有返回计划')

  return {
    executionMs: payload['Execution Time'] ?? 0,
    planningMs: payload['Planning Time'] ?? null,
    planLines: renderPlan(payload.Plan),
  }
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil(ratio * sorted.length) - 1)
  return sorted[Math.max(index, 0)] ?? 0
}

type Measurement = {
  rows: number
  index: 'none' | 'hnsw'
  executionMs: number[]
  p50: number
  p95: number
  planLines: string[]
}

async function measure(
  db: Db,
  label: Measurement['index'],
  rows: number,
  k: number,
  queries: number,
  queryVector: string,
): Promise<Measurement> {
  const query = sql`SELECT id FROM ann_probe ORDER BY embedding <=> ${queryVector}::vector LIMIT ${k}`

  const executionMs: number[] = []
  let planLines: string[] = []
  for (let i = 0; i < queries; i += 1) {
    const explained = await explainAnalyze(db, query)
    executionMs.push(explained.executionMs)
    planLines = explained.planLines
  }

  return {
    rows,
    index: label,
    executionMs,
    p50: percentile(executionMs, 0.5),
    p95: percentile(executionMs, 0.95),
    planLines,
  }
}

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2))
  const env = loadServerEnv()
  const db = createDb(env.DATABASE_URL)

  // 临时表：同 `vector(EMBEDDING_DIMENSIONS)` 列类型、同距离算子；随会话销毁。
  await db.execute(
    sql.raw(
      `CREATE TEMP TABLE ann_probe (id bigint PRIMARY KEY, embedding vector(${EMBEDDING_DIMENSIONS}) NOT NULL)`,
    ),
  )

  // 真实语料只认维度匹配的行：读路径本身有维度闸门，不同维度的向量也不该混进同一个 `vector(N)` 列。
  // ⚠️ 这是**超集**：不区分 model、不排除版本号已落后的行（读路径候选侧只召回新鲜行）。所以
  // `realEmbeddingRows` 只用来判"够不够跑 real 档"与 `needsAnn` 的行数腿 —— 偏严（保守），
  // 不代表读路径真能召回这么多行。
  const [realRows] = rowsOf<{ total: unknown; models: unknown }>(
    await db.execute(sql`
      SELECT count(*) AS total, count(DISTINCT model) AS models
      FROM embeddings
      WHERE dimensions = ${EMBEDDING_DIMENSIONS}
    `),
  )
  const realEmbeddingRows = Number(realRows?.total ?? 0)
  const realEmbeddingModels = Number(realRows?.models ?? 0)
  const largestSize = options.sizes.at(-1) ?? 0
  const source =
    options.source === 'auto'
      ? realEmbeddingRows >= largestSize
        ? 'real'
        : 'synthetic'
      : options.source
  if (source === 'real' && realEmbeddingRows < largestSize) {
    throw new UsageError(
      `--source=real 需要至少 ${largestSize} 条 dimensions=${EMBEDDING_DIMENSIONS} 的真实向量，当前 ${realEmbeddingRows} 条：先 bun run embed:backfill，或减少 --sizes，或改用 --source=synthetic`,
    )
  }

  logEvent({
    event: 'ann.probe.started',
    dimensions: EMBEDDING_DIMENSIONS,
    k: options.k,
    queries: options.queries,
    sizes: options.sizes,
    withIndex: options.withIndex,
    source,
    realEmbeddingRows,
    realEmbeddingModels,
  })

  if (source === 'real') {
    // 真实向量只读一次、只读最大的那个尺寸，并把 `rn` 固定下来：之后每个尺寸按 `rn = id` 追加，
    // 既不会重复用同一条（重复行会让 HNSW 的 recall 虚高），也不会因为窗口函数在两次追加里重排
    // 而把同一条塞进两个 id。
    await db.execute(sql`
      CREATE TEMP TABLE ann_seed AS
      SELECT row_number() OVER () AS rn, embedding
      FROM (
        SELECT embedding FROM embeddings
        WHERE dimensions = ${EMBEDDING_DIMENSIONS}
        LIMIT ${largestSize}
      ) AS picked
    `)
  }

  const measurements: Measurement[] = []
  let inserted = 0

  for (const size of options.sizes) {
    if (size < inserted) {
      // 尺寸必须递增：临时表只追加，不重建，否则前面的测量没有意义。
      throw new UsageError('--sizes 必须递增（脚本只追加行）')
    }

    if (source === 'real') {
      // 真实语料：按 `rn = id` 从 `ann_seed` 取，不重复、不重排（见上面的注释）。
      await db.execute(sql`
        INSERT INTO ann_probe (id, embedding)
        SELECT g, seed.embedding
        FROM generate_series(${inserted + 1}, ${size}) AS g
        JOIN ann_seed AS seed ON seed.rn = g
      `)
    } else {
      // 合成随机向量：`array_agg(random())` 直接 cast 成 vector，不经过 JS（10 万行 × 1536 维）。
      await db.execute(sql`
        INSERT INTO ann_probe (id, embedding)
        SELECT g, (SELECT array_agg(random()) FROM generate_series(1, ${EMBEDDING_DIMENSIONS}))::vector
        FROM generate_series(${inserted + 1}, ${size}) AS g
      `)
    }
    inserted = size
    await db.execute(sql`ANALYZE ann_probe`)

    // 查询向量取表里的第一条：真实语料下它就是**语料内的**向量，与生产一致（引擎用目标实体自己的
    // 向量查询，该向量本身也在表里），不是特意构造的"表外"查询。
    const vectorRows = rowsOf<{ vec: string }>(
      await db.execute(sql`SELECT embedding::text AS vec FROM ann_probe LIMIT 1`),
    )
    const queryVector = vectorRows[0]?.vec
    if (queryVector === undefined) throw new Error('临时表里没有向量可用于查询')

    const withoutIndex = await measure(db, 'none', size, options.k, options.queries, queryVector)
    measurements.push(withoutIndex)
    logEvent({
      event: 'ann.probe.measured',
      index: 'none',
      rows: size,
      p50Ms: withoutIndex.p50,
      p95Ms: withoutIndex.p95,
      runs: withoutIndex.executionMs,
      plan: withoutIndex.planLines,
    })

    if (options.withIndex) {
      await db.execute(
        sql.raw(
          'CREATE INDEX IF NOT EXISTS ann_probe_hnsw ON ann_probe USING hnsw (embedding vector_cosine_ops)',
        ),
      )
      const withIndex = await measure(db, 'hnsw', size, options.k, options.queries, queryVector)
      measurements.push(withIndex)
      logEvent({
        event: 'ann.probe.measured',
        index: 'hnsw',
        rows: size,
        p50Ms: withIndex.p50,
        p95Ms: withIndex.p95,
        runs: withIndex.executionMs,
        plan: withIndex.planLines,
      })
      // 关键：量完就删掉索引。否则**下一个尺寸**的"无索引"测量实际上走的是索引——
      // 本脚本第一版就踩了这个坑（5 万行的 exact scan 报到 0.42ms，计划里却是 Index Scan）。
      await db.execute(sql.raw('DROP INDEX IF EXISTS ann_probe_hnsw'))
    }
  }

  // 收尾：把"该不该建 HNSW"的判据直接算出来（触发条件：p95 > 50ms 或 > 10 万行）。
  // `triggerP95Ms` / `triggerRows` 是**约定阈值**（M2 记录 + Issue 提到的量级），**不是实测结果**；
  // 实测值都在 `measurements` 里。注意：本机合成语料下 10_000 行的 exact scan p95 就已经越过
  // 50ms 触发线（见 M4 文档 §5），所以"10 万行才触发"的说法不成立——判据是 p95，不是行数。
  const largestExact = measurements.filter((m) => m.index === 'none').at(-1)
  logEvent({
    event: 'ann.probe.summary',
    source,
    realEmbeddingRows,
    realEmbeddingModels,
    largestRows: largestExact?.rows ?? 0,
    largestP50Ms: largestExact?.p50 ?? 0,
    largestP95Ms: largestExact?.p95 ?? 0,
    triggerP95Ms: 50,
    triggerRows: 100_000,
    needsAnn: (largestExact?.p95 ?? 0) > 50 || realEmbeddingRows > 100_000,
    measurements: measurements.map((m) => ({
      rows: m.rows,
      index: m.index,
      p50Ms: m.p50,
      p95Ms: m.p95,
    })),
  })
}

try {
  await main()
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`${error.message}\n`)
    console.error(
      '用法：bun run ann:probe -- [--sizes=10000,50000,100000] [--queries=5] [--k=50] [--source=auto|real|synthetic] [--no-index]',
    )
    process.exit(2)
  }
  throw error
}
