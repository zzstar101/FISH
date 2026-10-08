import { RANKING_VERSION } from '@fish/contracts/matching/schema'
import { RECOMMENDATION_CLEANUP_INTERVAL_MS } from '@fish/contracts/recommendation/observability'
import { createDb } from '@fish/db/client'
import { loadEmbeddingEnv, loadServerEnv, loadVisualEmbeddingEnv } from '@fish/shared/env'
import { createVisualEmbeddingProvider } from '@fish/visual-embedding/providers/factory'
import { sql } from 'drizzle-orm'
import { purgeDueAccountDeletions } from './jobs/account-deletion/purge'
import { createEmbedJobHandlers } from './jobs/embedding/handlers'
import { createEmbeddingProvider } from './jobs/embedding/providers'
import { scheduleFailedEmbedRetry } from './jobs/embedding/requeue'
import { createInterestJobHandlers } from './jobs/interest/handlers'
import { InvalidJobPayloadError } from './jobs/invalid-payload-error'
import { cleanupRemovedListingImages } from './jobs/listing-image-cleanup'
import { createMatchJobHandlers } from './jobs/matching/handlers'
import { createJobQueue } from './jobs/queue'
import { cleanupExpiredRecommendationData } from './jobs/recommendation/cleanup'
import { cleanupExpiredViewHistory } from './jobs/view-history/cleanup'
import { createVisualBackfillRunner } from './jobs/visual-embedding/backfill'
import { cleanupExpiredVisualQueryImages } from './jobs/visual-embedding/cleanup'
import {
  createVisualEmbedJobHandlers,
  VisualSourceImageError,
} from './jobs/visual-embedding/handlers'
import { createVisualMaintenance } from './jobs/visual-embedding/maintenance'
import { elapsedMs, logErrorEvent, logEvent } from './log'
import { createWorkerMediaStorage } from './media-storage'

const POLL_INTERVAL_MS = 1000
/**
 * 视觉维护（回填 + 到期查询图清理）的间隔。
 *
 * 与 1s 轮询解耦：这两件事都是后台杂务，每次唤醒都打一次回填查询没有意义，而查询图的 TTL 是
 * 15 分钟——一分钟一轮已经远快于 TTL 的量级，也就谈不上"过期的图被多留了一会儿"。
 */
const VISUAL_MAINTENANCE_INTERVAL_MS = 60_000

/**
 * 浏览足迹清理（#415 M1）的间隔。
 *
 * 保留期是 30 天，小时级清理足够；它只删窗口外的行，读接口本来就按 30 天过滤，
 * 晚删一会儿不会让用户看到过期记录。
 */
const VIEW_HISTORY_CLEANUP_INTERVAL_MS = 3_600_000

/**
 * 被替换掉的公开商品图对象回收（#476）的间隔。
 *
 * 保留期是 24 小时，小时级清理足够：它只删「摘除超过一天、且确认无任何商品引用」的键，
 * 晚删一会儿不会让任何人看到坏图（对象早已无人引用）。
 */
const LISTING_IMAGE_CLEANUP_INTERVAL_MS = 3_600_000

/**
 * 账号注销到期执行（#464）的间隔。
 *
 * 冷静期是 7 天，注销本身是低频动作，分钟级足够 —— 到期与真正去标识化之间差一分钟对用户
 * 没有可感知差别（端上只承诺「到期后删除」）。注意 `lastRunAt = 0` 在这里**不会**让首轮立即执行：
 * 调度循环用单调时钟 `performance.now()`（进程启动时接近 0）与初值 0 比较，所以每个周期任务
 * 都要等满一个 `intervalMs`（既有实现的注释与行为不符，已在本 PR 中作为范围外问题报告）。
 */
const ACCOUNT_DELETION_PURGE_INTERVAL_MS = 60_000

const env = loadServerEnv()
const db = createDb(env.DATABASE_URL)

// embedding provider 在启动期装配：`EMBEDDING_TRANSPORT` 没有默认值，配错/没配在这里就失败，
// 而不是等第一条 EMBED_* job 跑起来才发疯（那时已经在库里留下状态）。
const embeddingEnv = loadEmbeddingEnv()

/**
 * 观测接线（#322 M4）：provider 每次上游请求一行 `embed.request`，handler 每个实体一行
 * `embed.entity`（`unchanged` 即内容指纹命中）。事件里只有计数/耗时/分类/模型名，没有请求文本
 * 与向量（见 `./log` 的硬约束）。
 *
 * 分流：`outcome !== 'ok'`（`retryable` / `fatal`）是失败事件，走 stderr——否则只收 stderr 的
 * 告警系统完全看不到上游请求失败（`log.ts` 头注释的"正常事件 stdout、失败事件 stderr"）。
 */
const embeddingProvider = createEmbeddingProvider(embeddingEnv, {
  onRequest: (event) => {
    const line = {
      event: 'embed.request',
      model: embeddingProvider.model,
      transport: embeddingEnv.transport,
      ...event,
    }
    if (event.outcome === 'ok') logEvent(line)
    else logErrorEvent(line)
  },
})

// 视觉 provider 同一理由在启动期装配（#324 M3）。`VISUAL_EMBEDDING_TRANSPORT` 同样没有默认值。
const visualEmbeddingEnv = loadVisualEmbeddingEnv()
const visualEmbeddingProvider = createVisualEmbeddingProvider(visualEmbeddingEnv)

/**
 * 视觉回填要读封面字节、查询图清理要删对象，所以 worker 也持有一个 S3 客户端。
 *
 * 只做两件事（见 `media-storage.ts`）：不签名、不拼公开 URL、不碰审核图代理——那些是 API 的职责。
 */
const mediaStorage = createWorkerMediaStorage(
  new Bun.S3Client({
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    bucket: env.S3_BUCKET,
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
  }),
)

// 启动自检：连不上 Postgres 立即失败，而不是空转。
await db.execute(sql`select 1`)
logEvent({
  event: 'worker.started',
  pollIntervalMs: POLL_INTERVAL_MS,
  transport: embeddingEnv.transport,
  model: embeddingProvider.model,
  dimensions: embeddingProvider.dimensions,
  rankingVersion: RANKING_VERSION,
  visualTransport: visualEmbeddingEnv.transport,
  visualModel: visualEmbeddingProvider.model,
  visualDimensions: visualEmbeddingProvider.dimensions,
})

/**
 * job 类型 → handler。匹配域（#8）与 embedding 域（#322 M1）、视觉回填域（#324 M8）各一张表
 * 在这里合并；新 domain 在对应目录加 `createXxxJobHandlers` 再展开一项
 * （`jobs.type` 是裸 text，TS 联合只是收窄，见 `packages/db/src/schema/jobs.ts:18`）。
 */
const queue = createJobQueue(db, {
  handlers: {
    // 匹配引擎必须显式拿到"本进程用的是哪个模型"：读向量与召回都按它过滤，绝不从表里随便取一行
    // （#322 M1 §11.6）。换模型 = 换这里的 provider，向量由 M4 的 backfill 重建。
    ...createMatchJobHandlers(db, { embeddingModel: embeddingProvider.model }),
    ...createEmbedJobHandlers(db, embeddingProvider, {
      // 失败态的 `embed.entity`（handler 先发事件再 rethrow）必须走 stderr——与 `job.settled`
      // 的失败分支同一约定（`log.ts` 头注释："正常事件 stdout、失败事件 stderr"）。
      onEvent: (event) => (event.status === 'failed' ? logErrorEvent(event) : logEvent(event)),
    }),
    // 长期兴趣画像（#323 R2）同样要显式拿到模型：聚合只吃当前模型的向量，换模型后由 backfill 重建。
    ...createInterestJobHandlers(db, { embeddingModel: embeddingProvider.model }),
    ...createVisualEmbedJobHandlers(db, visualEmbeddingProvider, mediaStorage),
  },
  isFatalError: (error) =>
    // 源封面确定性不可用（超限、魔术字节不符）重发不会变好 ⇒ 立即 FAILED，
    // 让数据问题在 ops 里可见，而不是每小时重跑一次同样的失败。
    error instanceof InvalidJobPayloadError || error instanceof VisualSourceImageError,
})

/** 周期性视觉维护：回填一批（封面新增/替换后的补齐）+ 清理到期查询图。 */
const visualBackfill = createVisualBackfillRunner({
  db,
  model: visualEmbeddingProvider.model,
})

/** 周期性清理 30 天前的浏览足迹（#415 M1）。失败只记日志，不影响主循环。 */
async function runViewHistoryCleanup(now: Date): Promise<void> {
  try {
    const cleanup = await cleanupExpiredViewHistory({ db, now })
    if (cleanup.deleted > 0) {
      console.log(`[worker] 清理过期浏览足迹 ${cleanup.deleted} 行`)
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`[worker] 浏览足迹清理失败：${detail}`)
  }
}

// 失败上报只写脱敏摘要（`errorMessage()`），理由见 `./jobs/visual-embedding/maintenance` 头注释。
const runVisualMaintenance = createVisualMaintenance({
  backfill: () => visualBackfill.runPass(),
  cleanup: (now) => cleanupExpiredVisualQueryImages({ db, storage: mediaStorage, now }),
})

/** 周期性回收被替换掉的公开商品图对象（#476）。失败只记日志，不影响主循环。 */
async function runListingImageCleanup(now: Date): Promise<void> {
  try {
    const result = await cleanupRemovedListingImages({ db, storage: mediaStorage, now })
    if (result.deleted > 0) {
      console.log(`[worker] 清理被替换的商品图对象 ${result.deleted} 个`)
    }
  } catch (error) {
    // 与视觉维护同一语义：一轮失败只记日志，下一轮自然重试（对象删除幂等）。
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`[worker] 商品图对象清理失败：${detail}`)
  }
}

/** 周期性保留期清理（#323 R6 §7）：删 90 天前的推荐上下文与 180 天前的埋点。 */
async function runRecommendationCleanup(now: Date): Promise<void> {
  try {
    const result = await cleanupExpiredRecommendationData({ db, now })
    if (result.deletedRequestItems + result.deletedRequests + result.deletedEvents > 0) {
      console.log(
        `[worker] 推荐数据清理：快照 ${result.deletedRequestItems} / 请求 ${result.deletedRequests} / 事件 ${result.deletedEvents}（${result.batches} 批）`,
      )
    }
  } catch (error) {
    // 与视觉维护同一语义：一轮失败只记日志，下一轮自然重试（删除幂等）。
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`[worker] 推荐数据清理失败：${detail}`)
  }
}

/**
 * 周期性执行到点的账号注销（#464）：去标识化 + 撤销全部会话 + 系统审计。
 *
 * 有动作才打日志（`purged` / `deferred` 非零）；空转不打 —— 每分钟一行「什么都不用做」会把
 * 日志淹掉。被推迟（出现未完成交易）必须打出来：那是一个需要人看一眼的滞留状态。
 */
async function runAccountDeletionPurge(now: Date): Promise<void> {
  try {
    const result = await purgeDueAccountDeletions({ db, now })
    if (result.purged > 0 || result.deferred > 0) {
      console.log(`[worker] 账号注销执行：${result.purged} 个已去标识化，${result.deferred} 个推迟`)
    }
    for (const outcome of result.outcomes) {
      if (outcome.kind === 'deferred-pending-transaction') {
        console.error(
          `[worker] 账号注销推迟（user=${outcome.userId}）：仍有 ${outcome.blockingTransactions} 笔未完成交易`,
        )
      }
    }
  } catch (error) {
    // 与其它周期任务同语义：一轮失败只记日志，下一轮自然重试（每个账号内部是事务，幂等）。
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`[worker] 账号注销执行失败：${detail}`)
  }
}

/**
 * 周期任务表（#323 R6 §7.1，**已确认**）：把原先单个 `lastMaintenanceAt` 换成一张小表。
 *
 * 理由：再来第三个定时任务时不必继续堆 `if`，且「首次循环立即跑一轮」（`lastRunAt = 0`）的既有
 * 行为可以逐项保留。每项自己吞异常——一个任务失败不该让另一个任务也停摆。
 *
 * #418 的浏览足迹清理（30 天保留期，小时级）也并入这张表，不再单留 `lastViewHistoryCleanupAt`。
 */
type MaintenanceSchedule = {
  intervalMs: number
  lastRunAt: number
  run: (now: Date) => Promise<void>
}

const SCHEDULES: MaintenanceSchedule[] = [
  { intervalMs: VISUAL_MAINTENANCE_INTERVAL_MS, lastRunAt: 0, run: runVisualMaintenance },
  { intervalMs: RECOMMENDATION_CLEANUP_INTERVAL_MS, lastRunAt: 0, run: runRecommendationCleanup },
  { intervalMs: VIEW_HISTORY_CLEANUP_INTERVAL_MS, lastRunAt: 0, run: runViewHistoryCleanup },
  // #476：回收被替换掉的公开商品图对象（24 小时保留期，小时级）。
  { intervalMs: LISTING_IMAGE_CLEANUP_INTERVAL_MS, lastRunAt: 0, run: runListingImageCleanup },
  // #464：账号注销冷静期到期（7 天）后执行去标识化。低频、单调、可重复执行。
  {
    intervalMs: ACCOUNT_DELETION_PURGE_INTERVAL_MS,
    lastRunAt: 0,
    run: runAccountDeletionPurge,
  },
]

/**
 * `EMBED_*` 终结失败后的有界补投（#322 M4 复审修复，范围外发现 #2）。
 *
 * 两类终态都走这里：主循环里 `runOnce()` 结算出的 `FAILED`，以及启动回收直接判死的行
 * （`recoverStaleClaims()` 的 `failedIds`）。队列本身不认识业务类型，所以"失败了要不要再排一条"
 * 只能由调用方决定；策略与额度见 `jobs/embedding/requeue.ts`。
 *
 * 事件一律走 stderr：它描述的是"某个 job 已经失败"的后续处理（`scheduled === false` 时就等于
 * 一条"不再自动重试"的告警），只收 stderr 的告警系统应该看得到。
 */
async function scheduleRetryFor(jobId: string): Promise<void> {
  const retry = await scheduleFailedEmbedRetry(db, jobId)
  if (retry.reason === 'not-embed' || retry.reason === 'not-failed') return
  logErrorEvent({
    event: 'embed.retry',
    jobId,
    jobType: retry.type,
    entityKey: retry.entityKey,
    entityId: retry.entityId,
    failedInWindow: retry.failedInWindow,
    scheduled: retry.scheduled,
    reason: retry.reason,
    delayMs: retry.delayMs,
  })
}

// 启动时回收上一次进程留下的僵死领取（`status = 'RUNNING'`）：`kill -9` 会让正在执行的 job
// 永远停在 RUNNING，没有这一步它不会再有第二次机会。
const recovered = await queue.recoverStaleClaims()
if (recovered.requeued > 0 || recovered.failed > 0) {
  logEvent({
    event: 'worker.recovered',
    requeued: recovered.requeued,
    failed: recovered.failed,
  })
}
// 回收时被判死的行（`attempts` 已达上限）同样需要补投机会，否则那次 `kill -9` 就等于"永久不再试"。
for (const failedId of recovered.failedIds) {
  await scheduleRetryFor(failedId)
}

console.log(`[worker] started (poll interval ${POLL_INTERVAL_MS}ms)`)

for (;;) {
  const startedAt = Bun.nanoseconds()
  const outcome = await queue.runOnce()
  if (outcome) {
    // 每个 job 一行 JSON：`result` 就是 handler 的返回值（MATCH_* 是 MatchRunResult，
    // 带 recall / fallbackReason / vectorCandidates / topKLatencyMs / matched / downgraded）。
    const event = {
      event: 'job.settled',
      jobId: outcome.id,
      jobType: outcome.type,
      status: outcome.status,
      durationMs: elapsedMs(startedAt),
      model: embeddingProvider.model,
      rankingVersion: RANKING_VERSION,
      result: outcome.result ?? null,
      lastError: outcome.lastError ?? null,
    }
    if (outcome.status === 'DONE') logEvent(event)
    else logErrorEvent(event)
    if (outcome.status === 'FAILED') await scheduleRetryFor(outcome.id)
  }

  // 首次循环立即跑一轮（每项 `lastRunAt = 0`）：启动就能补上历史数据的视觉向量、过期推荐数据
  // 与过期浏览足迹，不必等一个完整间隔。
  const now = performance.now()
  for (const schedule of SCHEDULES) {
    if (now - schedule.lastRunAt < schedule.intervalMs) continue
    schedule.lastRunAt = now
    await schedule.run(new Date())
  }

  await Bun.sleep(POLL_INTERVAL_MS)
}
