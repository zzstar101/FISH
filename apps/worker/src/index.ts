import { RECOMMENDATION_CLEANUP_INTERVAL_MS } from '@fish/contracts/recommendation/observability'
import { createDb } from '@fish/db/client'
import { loadEmbeddingEnv, loadServerEnv, loadVisualEmbeddingEnv } from '@fish/shared/env'
import { createVisualEmbeddingProvider } from '@fish/visual-embedding/providers/factory'
import { sql } from 'drizzle-orm'
import { createEmbedJobHandlers } from './jobs/embedding/handlers'
import { createEmbeddingProvider } from './jobs/embedding/providers'
import { createInterestJobHandlers } from './jobs/interest/handlers'
import { InvalidJobPayloadError } from './jobs/invalid-payload-error'
import { createMatchJobHandlers } from './jobs/matching/handlers'
import { createJobQueue } from './jobs/queue'
import { cleanupExpiredRecommendationData } from './jobs/recommendation/cleanup'
import { createVisualBackfillRunner } from './jobs/visual-embedding/backfill'
import { cleanupExpiredVisualQueryImages } from './jobs/visual-embedding/cleanup'
import {
  createVisualEmbedJobHandlers,
  VisualSourceImageError,
} from './jobs/visual-embedding/handlers'
import { createWorkerMediaStorage } from './media-storage'

const POLL_INTERVAL_MS = 1000
/**
 * 视觉维护（回填 + 到期查询图清理）的间隔。
 *
 * 与 1s 轮询解耦：这两件事都是后台杂务，每次唤醒都打一次回填查询没有意义，而查询图的 TTL 是
 * 15 分钟——一分钟一轮已经远快于 TTL 的量级，也就谈不上"过期的图被多留了一会儿"。
 */
const VISUAL_MAINTENANCE_INTERVAL_MS = 60_000

const env = loadServerEnv()
const db = createDb(env.DATABASE_URL)

// embedding provider 在启动期装配：`EMBEDDING_TRANSPORT` 没有默认值，配错/没配在这里就失败，
// 而不是等第一条 EMBED_* job 跑起来才发疯（那时已经在库里留下状态）。
const embeddingEnv = loadEmbeddingEnv()
const embeddingProvider = createEmbeddingProvider(embeddingEnv)

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
console.log('[worker] postgres connection ok')
console.log(
  `[worker] embedding provider: ${embeddingProvider.model} (${embeddingProvider.dimensions}d, transport=${embeddingEnv.transport})`,
)
console.log(
  `[worker] visual embedding provider: ${visualEmbeddingProvider.model} (${visualEmbeddingProvider.dimensions}d, transport=${visualEmbeddingEnv.transport})`,
)

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
    ...createEmbedJobHandlers(db, embeddingProvider),
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

async function runVisualMaintenance(now: Date): Promise<void> {
  try {
    const backfill = await visualBackfill.runPass()
    if (backfill.enqueued > 0) {
      console.log(`[worker] 视觉回填投递 ${backfill.enqueued} 条`)
    }
    const cleanup = await cleanupExpiredVisualQueryImages({ db, storage: mediaStorage, now })
    if (cleanup.deleted > 0) {
      console.log(`[worker] 清理到期查询图 ${cleanup.deleted} 个`)
    }
  } catch (error) {
    // 维护失败不能把 worker 主循环带走：回填游标留在内存里、清理按 expires_at 升序重来，
    // 下一轮会自然重新捡起同一批。
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`[worker] 视觉维护失败：${detail}`)
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
 * 周期任务表（#323 R6 §7.1，**已确认**）：把原先单个 `lastMaintenanceAt` 换成一张小表。
 *
 * 理由：再来第三个定时任务时不必继续堆 `if`，且「首次循环立即跑一轮」（`lastRunAt = 0`）的既有
 * 行为可以逐项保留。每项自己吞异常——一个任务失败不该让另一个任务也停摆。
 */
type MaintenanceSchedule = {
  intervalMs: number
  lastRunAt: number
  run: (now: Date) => Promise<void>
}

const SCHEDULES: MaintenanceSchedule[] = [
  { intervalMs: VISUAL_MAINTENANCE_INTERVAL_MS, lastRunAt: 0, run: runVisualMaintenance },
  { intervalMs: RECOMMENDATION_CLEANUP_INTERVAL_MS, lastRunAt: 0, run: runRecommendationCleanup },
]

// 启动时回收上一次进程留下的僵死领取（`status = 'RUNNING'`）：`kill -9` 会让正在执行的 job
// 永远停在 RUNNING，没有这一步它不会再有第二次机会。
const recovered = await queue.recoverStaleClaims()
if (recovered.requeued > 0 || recovered.failed > 0) {
  console.log(
    `[worker] 回收僵死 job：${recovered.requeued} 条重新入队，${recovered.failed} 条超上限置 FAILED`,
  )
}

console.log(`[worker] started (poll interval ${POLL_INTERVAL_MS}ms)`)

for (;;) {
  const outcome = await queue.runOnce()
  if (outcome) {
    const detail = outcome.lastError
      ? `：${outcome.lastError}`
      : ` ${JSON.stringify(outcome.result)}`
    const line = `[worker] ${outcome.type} ${outcome.status}${detail}`
    if (outcome.status === 'DONE') console.log(line)
    else console.error(line)
  }

  // 首次循环立即跑一轮（每项 `lastRunAt = 0`）：启动就能补上历史数据的视觉向量与过期推荐数据，
  // 不必等一个完整间隔。
  const now = performance.now()
  for (const schedule of SCHEDULES) {
    if (now - schedule.lastRunAt < schedule.intervalMs) continue
    schedule.lastRunAt = now
    await schedule.run(new Date())
  }

  await Bun.sleep(POLL_INTERVAL_MS)
}
