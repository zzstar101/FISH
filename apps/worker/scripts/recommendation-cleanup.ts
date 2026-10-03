// ---------------------------------------------------------------------------
// #323 R6 保留期清理 CLI（设计 §7.3）。
//
// 运行（仓库根目录，Bun 自动读根 `.env`）：
//   bun run recommendation:cleanup -- [--once] [--dry-run] [--batch-size=1000] [--json]
//
// `--once` 是**唯一**模式：跑一轮（三类各自循环到空）后退出。之所以保留这个旗标而不是省略它，
// 是因为它明确了"这个脚本不是常驻进程"——常驻调度在 worker 的 `SCHEDULES` 里。
// `--dry-run` 只统计待删行数（同一个截止时间条件，把 `DELETE` 换成 `count(*)`），一根行都不写。
// ---------------------------------------------------------------------------

import { RECOMMENDATION_CLEANUP_BATCH_SIZE } from '@fish/contracts/recommendation/observability'
import { createDb } from '@fish/db/client'
import { loadServerEnv } from '@fish/shared/env'
import { cleanupExpiredRecommendationData } from '../src/jobs/recommendation/cleanup'

const USAGE = `用法：
  bun run recommendation:cleanup -- [--once] [--dry-run] [--batch-size=1000] [--json]
`

export type CleanupCliOptions = {
  dryRun: boolean
  batchSize: number
  json: boolean
}

export function parseArgs(argv: readonly string[]): CleanupCliOptions {
  let dryRun = false
  let batchSize = RECOMMENDATION_CLEANUP_BATCH_SIZE
  let json = false

  for (const arg of argv) {
    if (arg === '--once') {
    } else if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--json') {
      json = true
    } else if (arg === '--help' || arg === '-h') {
      console.log(USAGE)
      process.exit(0)
    } else if (arg.startsWith('--batch-size=')) {
      const value = Number(arg.slice('--batch-size='.length))
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`--batch-size 应为正整数，实得 ${arg}`)
      }
      batchSize = value
    } else {
      throw new Error(`未知参数：${arg}\n${USAGE}`)
    }
  }

  return { dryRun, batchSize, json }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const env = loadServerEnv()
  const db = createDb(env.DATABASE_URL)
  try {
    const now = new Date()
    const result = await cleanupExpiredRecommendationData({
      db,
      now,
      batchSize: options.batchSize,
      dryRun: options.dryRun,
    })

    if (options.json) {
      console.log(
        JSON.stringify(
          { mode: options.dryRun ? 'dry-run' : 'apply', now: now.toISOString(), ...result },
          null,
          2,
        ),
      )
      return
    }

    // 保留期是"以天计"的，所以把两个截止时间打出来：看到"待删 0 行"时能立刻判断是"真没有"
    // 还是"窗口没算对"。
    console.log(
      options.dryRun
        ? '[recommendation-cleanup] 试运行：只统计待删行数，不写任何行'
        : '[recommendation-cleanup] 已执行清理',
    )
    console.log(`  快照行（90 天前请求的）：${result.deletedRequestItems}`)
    console.log(`  请求行（90 天前）：${result.deletedRequests}`)
    console.log(`  事件行（180 天前）：${result.deletedEvents}`)
    console.log(`  批次数：${result.batches}（批大小 ${options.batchSize}）`)
  } finally {
    await db.$client.close()
  }
}

// 与 `rank-eval.ts` 同约定：被测试 import 的 CLI 必须有守卫，否则 import 就会连库跑一遍。
if (import.meta.main) {
  await main()
}
