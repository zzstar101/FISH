// ---------------------------------------------------------------------------
// #324 M8 离线回填脚本：给「有封面、但没有当前封面视觉向量」的商品投递回填 job。
//
// 用途：首次全量回填、封面替换后的补齐、以及失败重试。语义与谓词见
// `../src/jobs/visual-embedding/backfill.ts`（回填 = 失效恢复机制）。
//
// 运行：bun run visual:backfill（仓库根目录；Bun 自动读根 `.env`）
//       bun --env-file=.env run apps/worker/scripts/visual-backfill.ts
//
// 注意：本脚本**只投递 job**，不生成向量——向量由 worker 的 VISUAL_EMBED_LISTING handler
// 生成（CAS + FOR UPDATE 复检 + 维度校验只有那一份实现）。所以跑这个脚本时 worker 必须在跑，
// 否则 job 会堆在队列里等 worker 起来。
// ---------------------------------------------------------------------------

import { createDb } from '@fish/db/client'
import { loadServerEnv, loadVisualEmbeddingEnv } from '@fish/shared/env'
import { createVisualEmbeddingProvider } from '@fish/visual-embedding/providers/factory'
import { drainVisualBackfill } from '../src/jobs/visual-embedding/backfill'

const env = loadServerEnv()
const visualEnv = loadVisualEmbeddingEnv()
const provider = createVisualEmbeddingProvider(visualEnv)
const db = createDb(env.DATABASE_URL)

console.log(
  `[visual-backfill] model=${provider.model} (${provider.dimensions}d, transport=${visualEnv.transport})`,
)
console.log('[visual-backfill] 开始扫描待回填商品（投递 job，不内联嵌入）')

const startedAt = performance.now()
const { batches, enqueued } = await drainVisualBackfill(db, { model: provider.model })
const elapsedMs = Math.round(performance.now() - startedAt)

console.log(`[visual-backfill] 投递 ${enqueued} 条 job（${batches} 批），耗时 ${elapsedMs}ms`)
if (enqueued > 0) {
  console.log('[visual-backfill] 向量由 worker 生成；请确认 worker 正在运行')
}

await db.$client.close()
