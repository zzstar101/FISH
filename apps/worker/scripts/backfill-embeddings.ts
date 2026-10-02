// ---------------------------------------------------------------------------
// #322 M4 backfill 脚本：给历史 ACTIVE 实体补向量，并触发一次匹配重算。
//
// 用途（Issue 的 "重建 / Backfill" 验收项）：
//   * 给现有 ACTIVE Listing / Wish 批量生成 embedding —— 走与生产 job **完全相同**的实现
//     （`generateEntityEmbedding()`：读实体 → 指纹比对 → provider → 原子复检 → 写入），
//     不是一个"只写向量的简化版"，因此指纹命中、并发覆盖、旧 job 晚到这些不变量自动成立；
//   * 写入成功的实体随即投一条 MATCH_* job，让历史匹配行从 `ranking_version = 1` 升到 2
//     （Issue 明确要求"重建完成后可触发 match 重算"，不允许要求人工逐条编辑）；
//   * **可断点续跑**：内容指纹命中（`unchanged`）的实体不重复调 provider / 不重复计费，
//     所以中断后直接重跑同一批即可（不建 checkpoint 表）；
//   * **有速率 / 并发上限**：默认并发 1、上限 4（上游限流 + "同一 DB 同时只能跑一个 worker"
//     两条约束下的保守值；每个实体=1 次请求，批量大小 1，天然不超过上游每请求行数上限）。
//
// 运行（仓库根目录）：
//   bun run embed:backfill -- --entity=listing --limit=100
//   bun run embed:backfill -- --dry-run
//   bun run apps/worker/scripts/backfill-embeddings.ts -- --entity=both --concurrency=2
//
// 参数：
//   --entity=listing|wish|both   默认 both
//   --limit=N                    每类最多处理 N 条（按 created_at, id 升序；默认不限）
//   --concurrency=N              并发数，默认 1，上限 4
//   --model=<name>               覆盖 `EMBEDDING_MODEL`（只在 live transport 生效）
//   --purge-other-models         每个实体写入成功后删除它**其它 model** 的向量行（换模型重建用；
//                                默认保留旧模型的行，以便"改回 EMBEDDING_MODEL"即可回滚）
//   --dry-run                    只统计将要处理多少条，不调 provider、不写库
//
// 换模型 = 改 `EMBEDDING_MODEL` + 跑本脚本（可选 `--model=` 覆盖，只影响本脚本）。
// 注意：脚本直接往 jobs 表投 MATCH_*，不 import `apps/api` 的队列封装——worker 不依赖 api 包；
// 投递形状与 `apps/api/src/modules/wishes/match-queue.ts` / `jobs/embedding/enqueue.ts` 保持一致
// （`::text::jsonb` 双转型，见 enqueue.ts 的注释）。
// ---------------------------------------------------------------------------

import { MATCH_JOB_TYPES } from '@fish/contracts/matching/jobs'
import type { Db } from '@fish/db/client'
import { createDb } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { embeddings } from '@fish/db/schema/embeddings'
import { listings } from '@fish/db/schema/listings'
import { wishes } from '@fish/db/schema/wishes'
import { loadEmbeddingEnv, loadServerEnv } from '@fish/shared/env'
import { and, asc, eq, ne, sql } from 'drizzle-orm'
import { generateEntityEmbedding } from '../src/jobs/embedding/handlers'
import { createEmbeddingProvider } from '../src/jobs/embedding/providers'
import { elapsedMs, errorMessage, logErrorEvent, logEvent } from '../src/log'

/** 并发上限：超过它对上游限流没有好处，只会让失败重试更密集。 */
const MAX_CONCURRENCY = 4
/** 每处理这么多条打一行进度（逐条事件仍然照打，进度行只是长跑时的路标）。 */
const PROGRESS_EVERY = 50

type EntityScope = 'listing' | 'wish' | 'both'

type BackfillOptions = {
  entity: EntityScope
  limit: number | null
  concurrency: number
  model: string | null
  dryRun: boolean
  purgeOtherModels: boolean
}

type BackfillTarget = { kind: 'listing' | 'wish'; id: string }

/** 参数错误（与运行期失败区分，退出码 2）。 */
class UsageError extends Error {}

function parseCount(raw: string, flag: string, min: number, max: number): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new UsageError(`${flag} 需要 ${min}..${max} 之间的整数，收到 ${JSON.stringify(raw)}`)
  }
  return value
}

function parseArgs(argv: string[]): BackfillOptions {
  const options: BackfillOptions = {
    entity: 'both',
    limit: null,
    concurrency: 1,
    model: null,
    dryRun: false,
    purgeOtherModels: false,
  }

  for (const arg of argv) {
    if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--purge-other-models') {
      options.purgeOtherModels = true
    } else if (arg.startsWith('--entity=')) {
      const value = arg.slice('--entity='.length)
      if (value !== 'listing' && value !== 'wish' && value !== 'both') {
        throw new UsageError(`--entity 只接受 listing|wish|both，收到 ${JSON.stringify(value)}`)
      }
      options.entity = value
    } else if (arg.startsWith('--limit=')) {
      options.limit = parseCount(
        arg.slice('--limit='.length),
        '--limit',
        1,
        Number.MAX_SAFE_INTEGER,
      )
    } else if (arg.startsWith('--concurrency=')) {
      options.concurrency = parseCount(
        arg.slice('--concurrency='.length),
        '--concurrency',
        1,
        MAX_CONCURRENCY,
      )
    } else if (arg.startsWith('--model=')) {
      const value = arg.slice('--model='.length)
      if (value.length === 0) throw new UsageError('--model 不能为空')
      options.model = value
    } else {
      throw new UsageError(`未知参数 ${JSON.stringify(arg)}`)
    }
  }

  return options
}

/**
 * 取该方向上要补向量的实体：**只处理 ACTIVE**（Issue 的措辞是"历史 ACTIVE 实体"），商品侧还要求
 * `moderation_status = 'APPROVED'` —— 与读路径的候选谓词一致（`engine.ts` 的 `creatable()` /
 * `visibleToWishOwner()`：未过审商品既不会进候选、也不会展示）。不筛这一项就是给永远不会成为候选的
 * 实体付费调 provider。
 * 排序固定为 `(created_at, id)`，配合 `--limit` 让多次运行覆盖同一批前缀。
 */
async function selectTargets(
  db: Db,
  kind: 'listing' | 'wish',
  limit: number | null,
): Promise<BackfillTarget[]> {
  const rows =
    kind === 'listing'
      ? await (limit === null
          ? db
              .select({ id: listings.id })
              .from(listings)
              .where(and(eq(listings.status, 'ACTIVE'), eq(listings.moderationStatus, 'APPROVED')))
              .orderBy(asc(listings.createdAt), asc(listings.id))
          : db
              .select({ id: listings.id })
              .from(listings)
              .where(and(eq(listings.status, 'ACTIVE'), eq(listings.moderationStatus, 'APPROVED')))
              .orderBy(asc(listings.createdAt), asc(listings.id))
              .limit(limit))
      : await (limit === null
          ? db
              .select({ id: wishes.id })
              .from(wishes)
              .where(eq(wishes.status, 'ACTIVE'))
              .orderBy(asc(wishes.createdAt), asc(wishes.id))
          : db
              .select({ id: wishes.id })
              .from(wishes)
              .where(eq(wishes.status, 'ACTIVE'))
              .orderBy(asc(wishes.createdAt), asc(wishes.id))
              .limit(limit))

  return rows.map((row) => ({ kind, id: row.id }))
}

/**
 * 投一条 MATCH_* job，让该实体的匹配行按新向量重算。
 *
 * `MATCH_WISH` 有 `jobs_match_wish_wish_id_pending_uidx`（partial unique），`ON CONFLICT DO NOTHING`
 * 就够；`MATCH_LISTING` **没有**唯一索引（M2/M3 一直如此），重跑会堆 PENDING 行，所以先删同实体的
 * 待跑行再插一条。
 */
async function enqueueMatchJob(db: Db, target: BackfillTarget): Promise<void> {
  if (target.kind === 'listing') {
    await db.execute(sql`
      DELETE FROM jobs
      WHERE type = ${MATCH_JOB_TYPES.listing} AND status = 'PENDING'
        AND payload->>'listingId' = ${target.id}
    `)
    await db.execute(sql`
      INSERT INTO jobs (id, type, payload)
      VALUES (${newId()}, ${MATCH_JOB_TYPES.listing}, ${JSON.stringify({ listingId: target.id })}::text::jsonb)
    `)
    return
  }

  await db.execute(sql`
    INSERT INTO jobs (id, type, payload)
    VALUES (${newId()}, ${MATCH_JOB_TYPES.wish}, ${JSON.stringify({ wishId: target.id })}::text::jsonb)
    ON CONFLICT DO NOTHING
  `)
}

/** 换模型重建时清掉该实体其它模型的向量行（默认不做，见文件头 `--purge-other-models`）。 */
async function purgeOtherModels(db: Db, target: BackfillTarget, keepModel: string): Promise<void> {
  await db
    .delete(embeddings)
    .where(
      and(
        eq(target.kind === 'listing' ? embeddings.listingId : embeddings.wishId, target.id),
        ne(embeddings.model, keepModel),
      ),
    )
}

/** 固定并发数的任务池：不引依赖，`--concurrency=1` 时就是顺序执行。 */
async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  run: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0
  const lanes = Array.from(
    { length: Math.min(concurrency, Math.max(items.length, 1)) },
    async () => {
      for (;;) {
        const index = next
        next += 1
        const item = items[index]
        if (item === undefined) return
        await run(item, index)
      }
    },
  )
  await Promise.all(lanes)
}

type BackfillCounts = {
  generated: number
  unchanged: number
  stale: number
  missing: number
  failed: number
  /** 因此投出 MATCH_* job 的实体数（`generated` + `unchanged`）。 */
  matched: number
}

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2))
  const env = loadServerEnv()
  const embeddingEnv = loadEmbeddingEnv()

  // `--model` 只对 live 有意义（stub 的模型名是编译期常量），因此只在 live 分支覆盖。
  const provider = createEmbeddingProvider(
    embeddingEnv.transport === 'live' && options.model !== null
      ? { ...embeddingEnv, model: options.model }
      : embeddingEnv,
    {
      onRequest: (event) => {
        const line = { event: 'embed.request', model: provider.model, ...event }
        // 与 worker 运行时同一约定：失败分类（retryable / fatal）走 stderr（`src/log.ts`）。
        if (event.outcome === 'ok') logEvent(line)
        else logErrorEvent(line)
      },
    },
  )
  const db = createDb(env.DATABASE_URL)

  const targets: BackfillTarget[] = []
  if (options.entity === 'listing' || options.entity === 'both') {
    targets.push(...(await selectTargets(db, 'listing', options.limit)))
  }
  if (options.entity === 'wish' || options.entity === 'both') {
    targets.push(...(await selectTargets(db, 'wish', options.limit)))
  }

  logEvent({
    event: 'embed.backfill.started',
    transport: embeddingEnv.transport,
    model: provider.model,
    dimensions: provider.dimensions,
    entity: options.entity,
    limit: options.limit,
    concurrency: options.concurrency,
    purgeOtherModels: options.purgeOtherModels,
    dryRun: options.dryRun,
    targets: targets.length,
  })

  if (options.dryRun) {
    logEvent({
      event: 'embed.backfill.summary',
      dryRun: true,
      transport: embeddingEnv.transport,
      model: provider.model,
      entity: options.entity,
      limit: options.limit,
      targets: targets.length,
      listings: targets.filter((target) => target.kind === 'listing').length,
      wishes: targets.filter((target) => target.kind === 'wish').length,
      durationMs: 0,
      counts: { generated: 0, unchanged: 0, stale: 0, missing: 0, failed: 0, matched: 0 },
    })
    return
  }

  const counts: BackfillCounts = {
    generated: 0,
    unchanged: 0,
    stale: 0,
    missing: 0,
    failed: 0,
    matched: 0,
  }
  const startedAt = Bun.nanoseconds()
  let processed = 0

  await mapWithConcurrency(targets, options.concurrency, async (target) => {
    try {
      const result = await generateEntityEmbedding(
        db,
        provider,
        { kind: target.kind, id: target.id },
        // 与 worker 同一约定：失败态的 `embed.entity` 走 stderr（`log.ts` 头注释）。
        {
          onEvent: (event) => (event.status === 'failed' ? logErrorEvent(event) : logEvent(event)),
        },
      )
      counts[result.status] += 1

      // `generated` / `unchanged` 才算"该实体的向量与当前内容一致"：前者刚写入，后者指纹命中。
      // `stale`（生成期间被编辑，本次结果被更新的内容取代）与 `missing`（实体已删）都不投匹配——
      // 前者由那次编辑自己投的 job 负责，后者没有可重算的目标。
      if (result.status === 'generated' || result.status === 'unchanged') {
        if (options.purgeOtherModels) await purgeOtherModels(db, target, provider.model)
        await enqueueMatchJob(db, target)
        counts.matched += 1
      }
    } catch (error) {
      counts.failed += 1
      logErrorEvent({
        event: 'embed.backfill.entity.failed',
        entityKind: target.kind,
        entityId: target.id,
        error: errorMessage(error),
      })
    } finally {
      processed += 1
      if (processed % PROGRESS_EVERY === 0) {
        logEvent({
          event: 'embed.backfill.progress',
          processed,
          targets: targets.length,
          durationMs: elapsedMs(startedAt),
          counts,
        })
      }
    }
  })

  logEvent({
    event: 'embed.backfill.summary',
    dryRun: false,
    transport: embeddingEnv.transport,
    model: provider.model,
    entity: options.entity,
    limit: options.limit,
    concurrency: options.concurrency,
    targets: targets.length,
    counts,
    durationMs: elapsedMs(startedAt),
  })

  // 有实体失败就以非 0 退出：backfill 的失败必须能被 CI / 运维脚本看见。
  if (counts.failed > 0) process.exitCode = 1
}

try {
  await main()
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`${error.message}\n`)
    console.error('用法：bun run embed:backfill -- [--entity=listing|wish|both] [--limit=N]')
    console.error('      [--concurrency=1..4] [--model=<name>] [--purge-other-models] [--dry-run]')
    process.exit(2)
  }
  throw error
}
