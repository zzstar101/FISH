import { createDb } from '@fish/db/client'
import { loadEmbeddingEnv, loadServerEnv } from '@fish/shared/env'
import { sql } from 'drizzle-orm'
import { createEmbedJobHandlers } from './jobs/embedding/handlers'
import { createEmbeddingProvider } from './jobs/embedding/providers'
import { InvalidJobPayloadError } from './jobs/invalid-payload-error'
import { createMatchJobHandlers } from './jobs/matching/handlers'
import { createJobQueue } from './jobs/queue'

const POLL_INTERVAL_MS = 1000

const env = loadServerEnv()
const db = createDb(env.DATABASE_URL)

// embedding provider 在启动期装配：`EMBEDDING_TRANSPORT` 没有默认值，配错/没配在这里就失败，
// 而不是等第一条 EMBED_* job 跑起来才发疯（那时已经在库里留下状态）。
const embeddingEnv = loadEmbeddingEnv()
const embeddingProvider = createEmbeddingProvider(embeddingEnv)

// 启动自检：连不上 Postgres 立即失败，而不是空转。
await db.execute(sql`select 1`)
console.log('[worker] postgres connection ok')
console.log(
  `[worker] embedding provider: ${embeddingProvider.model} (${embeddingProvider.dimensions}d, transport=${embeddingEnv.transport})`,
)

/**
 * job 类型 → handler。匹配域（#8）与 embedding 域（#322 M1）各一张表在这里合并；
 * 新 domain 在对应目录加 `createXxxJobHandlers` 再展开一项
 * （`jobs.type` 是裸 text，TS 联合只是收窄，见 `packages/db/src/schema/jobs.ts:18`）。
 */
const queue = createJobQueue(db, {
  handlers: {
    // 匹配引擎必须显式拿到"本进程用的是哪个模型"：读向量与召回都按它过滤，绝不从表里随便取一行
    // （#322 M1 §11.6）。换模型 = 换这里的 provider，向量由 M4 的 backfill 重建。
    ...createMatchJobHandlers(db, { embeddingModel: embeddingProvider.model }),
    ...createEmbedJobHandlers(db, embeddingProvider),
  },
  isFatalError: (error) => error instanceof InvalidJobPayloadError,
})

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
  await Bun.sleep(POLL_INTERVAL_MS)
}
