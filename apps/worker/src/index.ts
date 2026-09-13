import { createDb } from '@fish/db/client'
import { loadServerEnv } from '@fish/shared/env'
import { sql } from 'drizzle-orm'
import { createMatchJobHandlers, InvalidJobPayloadError } from './jobs/matching/handlers'
import { createJobQueue } from './jobs/queue'

const POLL_INTERVAL_MS = 1000

const env = loadServerEnv()
const db = createDb(env.DATABASE_URL)

// 启动自检：连不上 Postgres 立即失败，而不是空转。
await db.execute(sql`select 1`)
console.log('[worker] postgres connection ok')

/**
 * job 类型 → handler。目前只有匹配域（#8）；新 domain 在这里加一项
 * （`jobs.type` 是裸 text，TS 联合只是收窄，见 `packages/db/src/schema/jobs.ts:7-8`）。
 */
const queue = createJobQueue(db, {
  handlers: { ...createMatchJobHandlers(db) },
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
