import { createDb } from '@fish/db/client'
import { loadServerEnv } from '@fish/shared/env'
import { sql } from 'drizzle-orm'

const POLL_INTERVAL_MS = 1000

const env = loadServerEnv()
const db = createDb(env.DATABASE_URL)

// 启动自检：连不上 Postgres 立即失败，而不是空转。
await db.execute(sql`select 1`)
console.log('[worker] postgres connection ok')

/**
 * Job 轮询骨架。Job 表由 #2 建立，具体 job（如 #8 的匹配）在各自 Issue 内接入。
 * 本 Issue 不提前定义 Job schema，也不实现任何 job。
 */
async function pollJobs(): Promise<void> {
  // 扩展点：后续在此领取并执行 jobs 表中的任务。
}

console.log(`[worker] started (poll interval ${POLL_INTERVAL_MS}ms)`)

for (;;) {
  await pollJobs()
  await Bun.sleep(POLL_INTERVAL_MS)
}
