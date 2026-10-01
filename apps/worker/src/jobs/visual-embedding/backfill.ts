/**
 * 视觉向量回填（#324 M8）。
 *
 * ## 为什么回填就是"失效恢复"机制
 *
 * 封面被替换时旧向量**当场**不可召回（召回谓词是 `source_object_key = 当前封面键`，
 * 见 `packages/db/src/visual-embedding-store.ts`），所以"失效"不需要任何写入。
 * 需要发生的只有一件事：**给新封面补一条向量**。而 `listVisualEmbeddingBackfillBatch`
 * 的谓词恰好就是"有封面，且没有本模型的向量、或向量指向的不是当前封面"——于是
 * 周期性回填天然覆盖三种情况：
 * 1. 首次全量回填（历史数据）；
 * 2. 封面替换后的补齐；
 * 3. 之前回填失败（job FAILED / worker 未起）的行，重跑不重复计费。
 *
 * 三条调用路径都走同一个"投递 job"入口，**不做内联嵌入**：CAS、`FOR UPDATE` 复检、
 * 维度校验、失败重试都只有 handler 一份实现。
 *
 * ## 为什么不改商品写路径（不做事件驱动的即时投递）
 *
 * 写路径（`apps/api/src/modules/listings/store.ts` 的 `*Atomic`）属于 #286/#322 的既有模块，
 * 在那里加一个"封面变了就投 job"的钩子要动已有事务语义，而且**漏掉历史数据**：本 Issue 之前
 * 上架的商品不会有任何人给它投递。周期性回填既覆盖历史又不需要动别人的模块，代价是
 * 封面替换后到补齐之间有一段"搜不到这件商品"的窗口（长度 = 回填间隔）。这是本次刻意接受的
 * 取舍，PR 描述里写明；如果日后要收紧，正确做法是在写路径加钩子，回填仍然保留作兜底。
 */
import type { Db } from '@fish/db/client'
import { listVisualEmbeddingBackfillBatch } from '@fish/db/visual-embedding-store'
import { enqueueVisualEmbedJob } from './enqueue'

/** 一轮回填投递多少条 job。够小以免一次堆爆队列，够大以免回填爬得太慢。 */
export const VISUAL_BACKFILL_BATCH_SIZE = 50

export type VisualBackfillBatchResult = {
  scanned: number
  /** **真正新落库**的 job 数；候选已有待跑任务时（`ON CONFLICT DO NOTHING`）不计。 */
  enqueued: number
  /** 下一批的游标；`null` 表示按 `listings.id` 已经翻到末尾。 */
  nextCursor: string | null
}

/**
 * 投递一批回填 job。
 *
 * 游标按 `listings.id` 升序（uuidv7 单调），所以翻页**与结果集变化无关**：本批投递的行在
 * job 跑完后会从谓词里消失，也不会导致漏行或重行（详见 `listVisualEmbeddingBackfillBatch`）。
 */
export async function enqueueVisualBackfillBatch(
  db: Db,
  input: { model: string; limit?: number; afterId?: string | null },
): Promise<VisualBackfillBatchResult> {
  const rows = await listVisualEmbeddingBackfillBatch(db, {
    model: input.model,
    limit: input.limit ?? VISUAL_BACKFILL_BATCH_SIZE,
    afterId: input.afterId ?? null,
  })

  let enqueued = 0
  for (const row of rows) {
    // 候选 ≠ 新投递：该商品已有待跑任务时 `ON CONFLICT DO NOTHING` 不落行，按真实插入计数。
    if (await enqueueVisualEmbedJob(db, row.listingId)) enqueued += 1
  }

  return {
    scanned: rows.length,
    enqueued,
    nextCursor: rows.at(-1)?.listingId ?? null,
  }
}

/**
 * 周期性回填运行器：每轮投递一批并把游标推进一步，翻到末尾后回到开头。
 *
 * 保持在内存里而不是每轮从零开始：从零开始的话，只要有**一条永远补不上**的行（例如封面对象
 * 在库里但桶里已不存在），它就会永远占着队首，后面的商品一条都轮不到。内存游标让每轮都真正
 * 往前走，绕完一圈自然回到它。
 */
export function createVisualBackfillRunner(input: { db: Db; model: string; limit?: number }): {
  runPass: () => Promise<VisualBackfillBatchResult>
} {
  let afterId: string | null = null

  return {
    async runPass() {
      const result = await enqueueVisualBackfillBatch(input.db, {
        model: input.model,
        limit: input.limit,
        afterId,
      })
      afterId = result.nextCursor
      return result
    },
  }
}

/**
 * 一次跑到底（离线脚本用）：一直翻页直到没有待回填的行。
 *
 * `maxBatches` 是保险丝：谓词依赖"job 真的跑完才会让行消失"，如果脚本跑的时候 worker 没起，
 * 行不会消失，但游标仍在前进，所以循环一定会结束；这个上限只是防止误配 `limit` 时跑太久。
 */
export async function drainVisualBackfill(
  db: Db,
  input: { model: string; limit?: number; maxBatches?: number },
): Promise<{ batches: number; enqueued: number }> {
  const maxBatches = input.maxBatches ?? 1_000
  let afterId: string | null = null
  let batches = 0
  let enqueued = 0

  while (batches < maxBatches) {
    const result = await enqueueVisualBackfillBatch(db, {
      model: input.model,
      limit: input.limit,
      afterId,
    })
    batches += 1
    enqueued += result.enqueued
    if (
      result.nextCursor === null ||
      result.scanned < (input.limit ?? VISUAL_BACKFILL_BATCH_SIZE)
    ) {
      break
    }
    afterId = result.nextCursor
  }

  return { batches, enqueued }
}
