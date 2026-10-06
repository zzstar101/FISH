// ---------------------------------------------------------------------------
// #322 M4 只读聚合脚本：从库里派生"观测面"（不写任何行）。
//
// 为什么需要它：进程内的 JSON 日志（`worker.started` / `embed.request` / `embed.entity` /
// `job.settled`）回答的是"这一轮跑了什么"，而 Issue 的可观测性还要求能回答"现在库里整体是什么
// 状态"——覆盖率、模型分布、ranking_version 分布、job 成功率与耗时、**补投额度已用尽的实体**。
// 这些都能从 `embeddings` / `matches` / `jobs` 三张表直接算出来，因此不需要 metrics 基建、
// 不需要新表。
//
// 分工（别在这里找进程内指标）：
//   * 本脚本：DB 派生（覆盖率 / 模型分布 / ranking_version 分布 / job 成功率与耗时 /
//     额度用尽的补投实体）；
//   * worker 日志：单次运行（embedding 请求数与失败率、content-hash 命中率、Top-K 条数与
//     延迟、matched/downgraded、model 与 ranking_version，以及 `embed.retry` 的补投决定）。
//
// 运行（仓库根目录）：bun run obs:summary
//       bun run apps/worker/scripts/obs-summary.ts -- --model=text-embedding-v4
//
// 覆盖率口径与读路径一致：向量必须属于**指定模型**（读侧 `topKSimilarWishes()` 带
// `eq(embeddings.model, query.model)`），且 `embeddings.source_updated_at` 与实体 `updated_at`
// 在**毫秒截断后相等**才算"新鲜"（见 `packages/db/src/embedding-store.ts` 的
// `freshListingsEmbedding()`），再加上读路径对**目标向量**闸门里的维度与内容指纹两道
// （`engine.ts` 的 `loadTargetVector()`）——`contentHash` 那一腿由
// `src/jobs/embedding/content-hash-sql.ts` 在 SQL 里复刻
// `buildListingEmbeddingText()` / `buildWishEmbeddingText()` + `contentHashOf()` 后比对
// `embeddings.content_hash`（等价性由 `content-hash-sql.test.ts` 钉住）。默认模型 = `EMBEDDING_MODEL`（stub transport 下 =
// `STUB_EMBEDDING_MODEL`），可用 `--model=` 覆盖。多模型共存时只有该模型的新鲜向量算"可召回"；
// `withAnyVector` 是诊断口径（任何模型的向量都算），**不代表可召回**。
// 只比 `model` 会高估覆盖率——换了模型或内容改过、向量还没重算的行都是不可召回的。
// `withVersionFreshVector` 是补上指纹腿之前的**上界**口径，保留它只为让两者的差可见（正常情况下
// 差为 0；不为 0 说明有"版本号还没动、内容已经变了"的行，读侧会判 `stale` 而不是可召回）。
// ---------------------------------------------------------------------------

import type { Db } from '@fish/db/client'
import { createDb } from '@fish/db/client'
import { EMBEDDING_DIMENSIONS } from '@fish/db/schema/embeddings'
import { loadServerEnv } from '@fish/shared/env'
import { sql } from 'drizzle-orm'
import { embeddingContentHashSql } from '../src/jobs/embedding/content-hash-sql'
import { STUB_EMBEDDING_MODEL } from '../src/jobs/embedding/providers/stub'
import { listExhaustedEmbedRetries } from '../src/jobs/embedding/requeue'
import { errorMessage, logErrorEvent, logEvent } from '../src/log'

/** `db.execute()` 在不同驱动下可能是数组或 `{ rows }`（与 `jobs/queue.ts` 的 `toRows` 同口径）。 */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  const rows = (result as { rows?: unknown }).rows
  return Array.isArray(rows) ? (rows as T[]) : []
}

/** pg 的 `count(*)` 是 bigint，bun-sql 可能给字符串；统一成 number，避免 JSON 里混类型。 */
function toNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

/** 可空浮点（percentile 在无行时是 NULL）。 */
function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

type EntityCoverageRow = {
  active: unknown
  with_any_vector: unknown
  with_version_fresh_vector: unknown
  with_fresh_vector: unknown
}

type EmbeddingModelRow = {
  model: string
  dimensions: unknown
  vector_rows: unknown
  listing_vectors: unknown
  wish_vectors: unknown
  fresh_vectors: unknown
}

type MatchRow = {
  ranking_version: unknown
  rows: unknown
  semantic_null: unknown
  semantic_filled: unknown
  score_min: unknown
  score_p50: unknown
  score_max: unknown
}

type JobRow = {
  type: string
  status: string
  rows: unknown
  retried: unknown
  with_error: unknown
  done_p50_ms: unknown
  done_p95_ms: unknown
}

/** 参数错误（与运行期失败区分，退出码 2，与 backfill 脚本同惯例）。 */
class UsageError extends Error {}

type ObsOptions = { model: string | null }

function parseArgs(argv: string[]): ObsOptions {
  const options: ObsOptions = { model: null }
  for (const arg of argv) {
    if (arg.startsWith('--model=')) {
      const value = arg.slice('--model='.length).trim()
      if (!value) throw new UsageError('--model= 需要非空的模型名')
      options.model = value
    } else {
      throw new UsageError(`未知参数 ${JSON.stringify(arg)}`)
    }
  }
  return options
}

/**
 * 覆盖率按哪个模型算：读路径按 `model` 过滤，所以默认取"写入时用的那个模型"。
 * stub transport 下写库的模型名固定是 `STUB_EMBEDDING_MODEL`，此时即使 `EMBEDDING_MODEL` 有值
 * （它只描述"将来切到 live 会用谁"）也不能拿它统计，否则会报出假的 0 覆盖率。
 * 两者都没有时**不猜**，让调用方显式给 `--model=`。
 */
function defaultModel(source: Record<string, string | undefined>): string | null {
  if (source.EMBEDDING_TRANSPORT === 'stub') return STUB_EMBEDDING_MODEL
  return source.EMBEDDING_MODEL?.trim() || null
}

/**
 * 每类实体的覆盖率：分母是 ACTIVE 实体（listing 侧还要求审核通过），分子分别是"随便哪个模型有向量"
 * （诊断口径）与"有**指定模型**的**新鲜**向量"（四道闸门：模型 + 毫秒级版本号 + 维度 + 内容指纹）。
 * 新鲜判据按模型分别算，所以下面按模型再报一次。
 *
 * ⚠️ 分子是**保守下界**，不是"读路径实际会召回的数量"：读路径两侧的判据并不相同——候选侧
 * （`freshListingsEmbedding()` / `freshWishesEmbedding()`）只比模型 + 毫秒级版本号，目标侧
 * （`engine.ts` 的 dimensions/contentHash 闸门）只比维度 + 指纹。这里取的是**两者的交集**，
 * 比任何一侧都严；所以 `withFreshVector` 偏低（少报）而不是偏高。
 *
 * 内容指纹那一腿由 `embeddingContentHashSql()` 在 SQL 里复刻 TS 侧的文本构造（#322 M4 复审修复：
 * 范围外发现 #5——此前只比版本号，报出来的是上界）。
 */
async function entityCoverage(
  db: Db,
  kind: 'listing' | 'wish',
  model: string,
): Promise<EntityCoverageRow> {
  const table = kind === 'listing' ? sql`listings` : sql`wishes`
  const column = kind === 'listing' ? sql`listing_id` : sql`wish_id`
  // 版本号那道闸门与读路径逐字一致（`freshListingsEmbedding()` / `freshWishesEmbedding()`）。
  const versionFresh = sql`date_trunc('milliseconds', e.source_updated_at) = date_trunc('milliseconds', t.updated_at)
                            AND e.dimensions = ${EMBEDDING_DIMENSIONS}`
  // 加上 `contentHash` 那一腿后是**两侧闸门的交集**（见上面函数注释：保守下界）；只算版本号是上界
  // （`withVersionFreshVector`）。
  const fresh = sql`${versionFresh} AND e.content_hash = ${embeddingContentHashSql(kind, sql`t`)}`
  // "能成为候选"的实体谓词也要与读路径一致：listing 侧除了 ACTIVE 还要求
  // `moderation_status = 'APPROVED'`（`engine.ts` 的 `creatable()` / `visibleToWishOwner()`），
  // 否则覆盖率的分母会把永远不会被召回的实体算进来。
  const visible =
    kind === 'listing'
      ? sql`t.status = 'ACTIVE' AND t.moderation_status = 'APPROVED'`
      : sql`t.status = 'ACTIVE'`
  const visibleScalar =
    kind === 'listing'
      ? sql`status = 'ACTIVE' AND moderation_status = 'APPROVED'`
      : sql`status = 'ACTIVE'`

  const [row] = rowsOf<EntityCoverageRow>(
    await db.execute(sql`
    SELECT
      (SELECT count(*) FROM ${table} WHERE ${visibleScalar}) AS active,
      (SELECT count(*) FROM ${table} t
         WHERE ${visible}
           AND EXISTS (SELECT 1 FROM embeddings e WHERE e.${column} = t.id)) AS with_any_vector,
      (SELECT count(*) FROM ${table} t
         WHERE ${visible}
           AND EXISTS (SELECT 1 FROM embeddings e
                        WHERE e.${column} = t.id AND e.model = ${model} AND ${versionFresh})) AS with_version_fresh_vector,
      (SELECT count(*) FROM ${table} t
         WHERE ${visible}
           AND EXISTS (SELECT 1 FROM embeddings e
                        WHERE e.${column} = t.id AND e.model = ${model} AND ${fresh})) AS with_fresh_vector
  `),
  )

  return (
    row ?? {
      active: 0,
      with_any_vector: 0,
      with_version_fresh_vector: 0,
      with_fresh_vector: 0,
    }
  )
}

/** 每个模型各有多少行、覆盖多少个**新鲜**实体（换模型重建后这里会出现多行）。 */
async function embeddingModels(db: Db): Promise<EmbeddingModelRow[]> {
  // `fresh_vectors` 与 `entityCoverage()` 同口径：毫秒级版本号 + 内容指纹（不止版本号）。
  const listingFresh = sql`date_trunc('milliseconds', e.source_updated_at) = date_trunc('milliseconds', l.updated_at)
                           AND e.content_hash = ${embeddingContentHashSql('listing', sql`l`)}`
  const wishFresh = sql`date_trunc('milliseconds', e.source_updated_at) = date_trunc('milliseconds', w.updated_at)
                        AND e.content_hash = ${embeddingContentHashSql('wish', sql`w`)}`

  return rowsOf<EmbeddingModelRow>(
    await db.execute(sql`
    SELECT
      e.model,
      vector_dims(e.embedding) AS dimensions,
      count(*) AS vector_rows,
      count(*) FILTER (WHERE e.listing_id IS NOT NULL) AS listing_vectors,
      count(*) FILTER (WHERE e.wish_id IS NOT NULL) AS wish_vectors,
      count(*) FILTER (
        WHERE (e.listing_id IS NOT NULL AND ${listingFresh})
           OR (e.wish_id IS NOT NULL AND ${wishFresh})
      ) AS fresh_vectors
    FROM embeddings e
    LEFT JOIN listings l ON l.id = e.listing_id
    LEFT JOIN wishes w ON w.id = e.wish_id
    GROUP BY e.model, vector_dims(e.embedding)
    ORDER BY vector_rows DESC, e.model, dimensions
  `),
  )
}

/** `ranking_version` 分布 + 语义分填充率 + 分数分位（v1 行的 `semantic_score` 必须是 NULL）。 */
async function matchDistribution(db: Db): Promise<MatchRow[]> {
  return rowsOf<MatchRow>(
    await db.execute(sql`
    SELECT
      ranking_version,
      count(*) AS rows,
      count(*) FILTER (WHERE semantic_score IS NULL) AS semantic_null,
      count(*) FILTER (WHERE semantic_score IS NOT NULL) AS semantic_filled,
      min(score) AS score_min,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY score) AS score_p50,
      max(score) AS score_max
    FROM matches
    GROUP BY ranking_version
    ORDER BY ranking_version
  `),
  )
}

/**
 * job 成功率与耗时。`jobs` 没有 duration 列，用 `(updated_at - created_at)` 作为
 * "从建行到结算"的耗时近似（同一事务里插入 → 结算会更新 `updated_at`，见 `jobs/queue.ts` 的 settle）。
 */
async function jobStats(db: Db): Promise<JobRow[]> {
  return rowsOf<JobRow>(
    await db.execute(sql`
    SELECT
      type,
      status,
      count(*) AS rows,
      count(*) FILTER (WHERE attempts > 1) AS retried,
      count(*) FILTER (WHERE last_error IS NOT NULL) AS with_error,
      percentile_cont(0.5) WITHIN GROUP (
        ORDER BY extract(epoch FROM (updated_at - created_at)) * 1000
      ) FILTER (WHERE status = 'DONE') AS done_p50_ms,
      percentile_cont(0.95) WITHIN GROUP (
        ORDER BY extract(epoch FROM (updated_at - created_at)) * 1000
      ) FILTER (WHERE status = 'DONE') AS done_p95_ms
    FROM jobs
    GROUP BY type, status
    ORDER BY type, status
  `),
  )
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const model = options.model ?? defaultModel(process.env)
  if (model === null) {
    throw new UsageError('无法确定统计哪个模型：请传 --model=<name>，或设置 EMBEDDING_MODEL')
  }
  const env = loadServerEnv()
  const db = createDb(env.DATABASE_URL)

  const [listingsCoverage, wishesCoverage] = await Promise.all([
    entityCoverage(db, 'listing', model),
    entityCoverage(db, 'wish', model),
  ])
  const models = await embeddingModels(db)
  const matches = await matchDistribution(db)
  const jobs = await jobStats(db)
  // #322 M4 §12.1 缺口 #2：额度用尽此前只有一行 stderr（`embed.retry`），事后查不到状态。
  // 这里按同一判据（同一组常量）把它变成可查询/可聚合的明细与计数。
  const exhaustedRetries = await listExhaustedEmbedRetries(db)

  const coverage = {
    listings: {
      active: toNumber(listingsCoverage.active),
      withAnyVector: toNumber(listingsCoverage.with_any_vector),
      // 上界口径（只比模型 + 毫秒级版本号 + 维度）；`withFreshVector` 多比一腿内容指纹，是
      // 两侧闸门的交集 ⇒ 保守下界（少报），不是"读路径实际召回数"。
      withVersionFreshVector: toNumber(listingsCoverage.with_version_fresh_vector),
      withFreshVector: toNumber(listingsCoverage.with_fresh_vector),
    },
    wishes: {
      active: toNumber(wishesCoverage.active),
      withAnyVector: toNumber(wishesCoverage.with_any_vector),
      withVersionFreshVector: toNumber(wishesCoverage.with_version_fresh_vector),
      withFreshVector: toNumber(wishesCoverage.with_fresh_vector),
    },
  }

  logEvent({
    event: 'obs.embeddings',
    // 覆盖率是按这个模型算的（`withAnyVector` 例外：它是任何模型的诊断口径）。
    model,
    coverage,
    models: models.map((row) => ({
      model: row.model,
      dimensions: toNumber(row.dimensions),
      vectorRows: toNumber(row.vector_rows),
      listingVectors: toNumber(row.listing_vectors),
      wishVectors: toNumber(row.wish_vectors),
      freshVectors: toNumber(row.fresh_vectors),
    })),
  })

  logEvent({
    event: 'obs.matches',
    byRankingVersion: matches.map((row) => ({
      rankingVersion: toNumber(row.ranking_version),
      rows: toNumber(row.rows),
      semanticNull: toNumber(row.semantic_null),
      semanticFilled: toNumber(row.semantic_filled),
      scoreMin: toNumberOrNull(row.score_min),
      scoreP50: toNumberOrNull(row.score_p50),
      scoreMax: toNumberOrNull(row.score_max),
    })),
  })

  logEvent({
    event: 'obs.jobs',
    byTypeStatus: jobs.map((row) => ({
      jobType: row.type,
      status: row.status,
      rows: toNumber(row.rows),
      retried: toNumber(row.retried),
      withError: toNumber(row.with_error),
      doneP50Ms: toNumberOrNull(row.done_p50_ms),
      doneP95Ms: toNumberOrNull(row.done_p95_ms),
    })),
  })

  // 额度用尽的实体明细：`stderr` 的 `embed.retry`（`reason='budget-exhausted'`）是**事件**，
  // 这一组是**状态**——可以随时重跑、可以按 `stuck` 聚合告警。给出实体 id 是为了让告警可操作
  // （人工跑 `bun run embed:backfill`）；id 不是用户文本，符合 `src/log.ts` 的字段约束。
  logEvent({
    event: 'obs.retries',
    entities: exhaustedRetries.map((row) => ({
      jobType: row.type,
      entityKey: row.entityKey,
      entityId: row.entityId,
      failedInWindow: row.failedInWindow,
      // false = 此刻没有待跑的 EMBED_*；不代表自动路径已断——编辑商品会无配额限制地重投一条
      // （`apps/api/src/modules/listings/store.ts` 的成对投递），人工 backfill 只是兜底。
      pending: row.pending,
    })),
  })

  // 收尾一行"抬头数字"：覆盖不足与失败率一眼可见（不需要再去数上面的明细）。
  const failedJobs = jobs
    .filter((row) => row.status === 'FAILED')
    .reduce((sum, row) => sum + toNumber(row.rows), 0)
  const jobRows = jobs.reduce((sum, row) => sum + toNumber(row.rows), 0)
  // 失败率的分母只算**已结算**（DONE / FAILED）的 job：PENDING / RUNNING 还没有结果，
  // 把它们计进分母会系统性低估失败率（口径写在 M4 §7）。
  const settledJobs = jobs
    .filter((row) => row.status === 'DONE' || row.status === 'FAILED')
    .reduce((sum, row) => sum + toNumber(row.rows), 0)
  const rowsForRankingVersion = (version: number): number =>
    matches
      .filter((row) => toNumber(row.ranking_version) === version)
      .reduce((sum, row) => sum + toNumber(row.rows), 0)

  logEvent({
    event: 'obs.summary',
    model,
    modelCount: models.length,
    activeListings: coverage.listings.active,
    freshListingVectors: coverage.listings.withFreshVector,
    activeWishes: coverage.wishes.active,
    freshWishVectors: coverage.wishes.withFreshVector,
    matchRows: matches.reduce((sum, row) => sum + toNumber(row.rows), 0),
    rankingVersion1Rows: rowsForRankingVersion(1),
    rankingVersion2Rows: rowsForRankingVersion(2),
    jobRows,
    settledJobs,
    failedJobs,
    // #322 M4 §12.1 缺口 #2：`EMBED_*` 补投额度（24 h 内 3 条 `FAILED`）用尽的实体数；
    // `stuckEmbedRetries` 是其中**没有待跑任务**的（自动路径已断，需人工 `embed:backfill`）。
    // 仓库没有告警基建，这两个计数是"可查询/可聚合"，不等同于真正的告警通道。
    exhaustedEmbedRetries: exhaustedRetries.length,
    stuckEmbedRetries: exhaustedRetries.filter((row) => !row.pending).length,
    failedRate: settledJobs === 0 ? null : failedJobs / settledJobs,
  })
}

try {
  await main()
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`${error.message}\n`)
    console.error('用法：bun run obs:summary -- [--model=<name>]')
    process.exit(2)
  }
  logErrorEvent({ event: 'obs.failed', error: errorMessage(error) })
  process.exitCode = 1
}
